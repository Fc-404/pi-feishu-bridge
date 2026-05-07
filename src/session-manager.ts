/**
 * pi AgentSession 管理器
 * 每个飞书用户/群聊一个独立 session，自动持久化
 * 支持 /new(重建) /stop(中止) /compact(压缩) 命令
 * 支持提示词文件 + 记忆文件
 */

import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  createCodingTools,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { mkdirSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BridgeConfig } from "./config.js";

export interface SessionEntry {
  session: AgentSession;
  createdAt: number;
  lastUsedAt: number;
  chatId: string;
  isProcessing: boolean;
  abortCurrent?: () => void;
}

/** 提示词文件和记忆文件的路径 */
function getDataFiles() {
  const dir = resolve(".pi");
  mkdirSync(dir, { recursive: true });
  return {
    promptFile: join(dir, "feishu-prompt.md"),
    memoryFile: join(dir, "feishu-memory.md"),
  };
}

/** 读取提示词文件 */
export function readPromptFile(): string {
  const { promptFile } = getDataFiles();
  try {
    if (existsSync(promptFile)) {
      return readFileSync(promptFile, "utf-8").trim();
    }
  } catch { /* 忽略 */ }
  return "";
}

/** 读取记忆文件 */
export function readMemoryFile(): string {
  const { memoryFile } = getDataFiles();
  try {
    if (existsSync(memoryFile)) {
      return readFileSync(memoryFile, "utf-8").trim();
    }
  } catch { /* 忽略 */ }
  return "";
}

/** 写入记忆文件 */
export function writeMemoryFile(content: string): void {
  const { memoryFile } = getDataFiles();
  try {
    writeFileSync(memoryFile, content, "utf-8");
  } catch (err) {
    console.error("[记忆文件] 写入失败:", err);
  }
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

  /** 构造带提示词和记忆的消息 */
  buildMessage(userText: string): string {
    const parts: string[] = [];

    const prompt = readPromptFile();
    if (prompt) {
      parts.push(prompt);
    }

    const memory = readMemoryFile();
    if (memory) {
      parts.push(`---\n## 记忆文件 (可读写)\n\n${memory}\n\n---\n`);
    }

    parts.push(userText);
    return parts.join("\n\n");
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

  /** 销毁并重建 session（/new） */
  async resetSession(sessionKey: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.sessions.get(sessionKey);
    if (entry) {
      if (entry.isProcessing && entry.abortCurrent) {
        entry.abortCurrent();
      }
      entry.session.dispose();
      this.sessions.delete(sessionKey);
    }

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

  /** 仅中止当前处理，不清除上下文（/stop） */
  abortProcessing(sessionKey: string): boolean {
    const entry = this.sessions.get(sessionKey);
    if (entry && entry.isProcessing && entry.abortCurrent) {
      entry.abortCurrent();
      return true;
    }
    return false;
  }

  /** 压缩上下文（/compact） */
  async compactSession(sessionKey: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) {
      return { success: false, error: "没有活跃的会话" };
    }
    try {
      await entry.session.compact();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
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

    const entry = sessionKey ? this.sessions.get(sessionKey) : undefined;
    if (entry) entry.isProcessing = true;

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

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      unsub();
      if (entry) entry.isProcessing = false;
      session.abort();
      onError("⏱️ 请求超时，请重试或使用 /new 重建会话");
    }, this.config.timeout);

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
        if (errMsg.includes("context") || errMsg.includes("token") || errMsg.includes("length")) {
          onError("📦 上下文已满，请发送 /new 开始新会话，或发送 /compact 压缩后继续");
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

  private async createNewSession(sessionKey: string): Promise<AgentSession> {
    // 工作目录：优先用配置的 cwd，否则用用户沙箱
    const workDir = this.config.cwd || join(this.config.workspacesDir, sessionKey);
    mkdirSync(workDir, { recursive: true });

    const sessionFile = join(this.config.sessionsDir, `${sessionKey}.jsonl`);

    const { session } = await createAgentSession({
      cwd: workDir,
      sessionManager: SessionManager.open(sessionFile),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      tools: createCodingTools(workDir) as any,
    });

    return session;
  }

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
