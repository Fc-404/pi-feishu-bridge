/**
 * pi AgentSession 管理器
 * 每个飞书用户/群聊一个独立 session，自动持久化
 */

import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  createCodingTools,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "./config.js";

export interface SessionEntry {
  session: AgentSession;
  createdAt: number;
  lastUsedAt: number;
  chatId: string;
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
    });
    return session;
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
  ): Promise<{ abort: () => void }> {
    const { onDelta, onDone, onError } = callbacks;
    let finished = false;

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
          onDone();
          break;
      }
    });

    // 超时控制
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      unsub();
      session.abort();
      onError("请求超时");
    }, this.config.timeout);

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
        onError(String(err));
      }
      return { abort: () => {} };
    } finally {
      clearTimeout(timeout);
    }

    return {
      abort: () => {
        if (!finished) {
          finished = true;
          unsub();
          session.abort();
        }
      },
    };
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

  /** 清理空闲 session */
  cleanIdle(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastUsedAt > maxAgeMs) {
        entry.session.dispose();
        this.sessions.delete(key);
      }
    }
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
      })),
    };
  }

  dispose() {
    for (const entry of this.sessions.values()) {
      entry.session.dispose();
    }
    this.sessions.clear();
  }
}
