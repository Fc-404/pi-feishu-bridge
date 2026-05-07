/**
 * pi AgentSession 管理器
 * 每个飞书用户/群聊一个独立 session，自动持久化
 * 不再自动清理空闲 session，用户通过 /new 手动重建
 */

import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  createCodingTools,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "./config.js";

export interface SessionEntry {
  session: AgentSession;
  createdAt: number;
  lastUsedAt: number;
  chatId: string;
  /** 当前是否有进行中的 prompt */
  isProcessing: boolean;
  /** 调用 abort 取消当前处理 */
  abortCurrent?: () => void;
}

export class PiSessionManager {
  private sessions = new Map<string, SessionEntry>();
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;

  constructor(private config: BridgeConfig) {
    mkdirSync(config.sessionsDir, { recursive: true });
    mkdirSync(config.workspacesDir, { recursive: true });

    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  /** 获取或创建用户的 pi session */
  async getOrCreate(sessionKey: string, chatId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.session;
    }

    const session = await this.createNewSession(sessionKey);
    this.sessions.set(sessionKey, {
      session,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      chatId,
      isProcessing: false,
    });
    return session;
  }

  /** 销毁并重建 session（对应 /new 命令） */
  async resetSession(sessionKey: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.sessions.get(sessionKey);
    if (entry) {
      // 如果有进行中的操作，先中止
      if (entry.isProcessing && entry.abortCurrent) {
        entry.abortCurrent();
      }
      // 释放旧 session
      entry.session.dispose();
      this.sessions.delete(sessionKey);
    }

    // 删除旧的会话文件
    const sessionFile = join(this.config.sessionsDir, `${sessionKey}.jsonl`);
    if (existsSync(sessionFile)) {
      try {
        unlinkSync(sessionFile);
      } catch {
        return { success: false, error: "无法删除旧会话文件" };
      }
    }

    return { success: true };
  }

  /** 发送 prompt 并监听结果 */
  async prompt(
    session: AgentSession,
    text: string,
    callbacks: {
      onDelta: (delta: string) => void;
      onDone: () => void;
      onError: (err: string) => void;
    },
    sessionKey?: string,
  ): Promise<{ abort: () => void }> {
    const { onDelta, onDone, onError } = callbacks;
    let finished = false;

    // 标记正在处理
    const entry = sessionKey ? this.sessions.get(sessionKey) : undefined;
    if (entry) entry.isProcessing = true;

    // 流式订阅
    const unsub = session.subscribe((event) => {
      if (finished) return;

      switch (event.type) {
        case "message_update":
          if (
            "assistantMessageEvent" in event &&
            event.assistantMessageEvent?.type === "text_delta"
          ) {
            onDelta(event.assistantMessageEvent.delta);
          }
          break;
        case "agent_end":
          finished = true;
          unsub();
          if (entry) entry.isProcessing = false;
          onDone();
          break;
      }
    });

    // 超时控制
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      unsub();
      if (entry) entry.isProcessing = false;
      session.abort();
      onError("⏱️ 请求超时，请重试或使用 /new 重建会话");
    }, this.config.timeout);

    // 保存 abort 函数
    const abortFn = () => {
      if (finished) return;
      finished = true;
      unsub();
      clearTimeout(timeout);
      if (entry) entry.isProcessing = false;
      session.abort();
    };
    if (entry) entry.abortCurrent = abortFn;

    try {
      if (session.isStreaming) {
        await session.steer(text);
      } else {
        await session.prompt(text);
      }
    } catch (err) {
      if (!finished) {
        finished = true;
        unsub();
        clearTimeout(timeout);
        if (entry) entry.isProcessing = false;
        const errMsg = String(err);
        // 上下文超长等错误，提示用户用 /new
        if (errMsg.includes("context") || errMsg.includes("token") || errMsg.includes("length")) {
          onError(`📦 上下文已满，请发送 /new 开始新会话`);
        } else {
          onError(`❌ ${errMsg}`);
        }
      }
      return { abort: () => {} };
    } finally {
      clearTimeout(timeout);
    }

    return { abort: abortFn };
  }

  /** 创建新 session */
  private async createNewSession(sessionKey: string): Promise<AgentSession> {
    const cwd = join(this.config.workspacesDir, sessionKey);
    mkdirSync(cwd, { recursive: true });

    const sessionFile = join(this.config.sessionsDir, `${sessionKey}.jsonl`);

    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.open(sessionFile),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      tools: createCodingTools(cwd) as any,
    });

    return session;
  }

  /** 获取统计 */
  getStats() {
    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([key, entry]) => ({
        key,
        chatId: entry.chatId,
        createdAt: new Date(entry.createdAt).toISOString(),
        lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
        isProcessing: entry.isProcessing,
      })),
    };
  }

  /** 检查 session 是否正在处理 */
  isProcessing(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.isProcessing ?? false;
  }

  dispose() {
    for (const entry of this.sessions.values()) {
      entry.session.dispose();
    }
    this.sessions.clear();
  }
}
