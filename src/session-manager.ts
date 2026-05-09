/**
 * 单例 pi AgentSession 管理器
 *
 * - 所有飞书消息共享同一个 pi session
 * - Session 存储在 ~/.pi/agent/sessions/--home-feishu--/feishu.jsonl
 * - /new 归档旧会话（加时间戳），创建新会话，不删除任何数据
 */

import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "./config.js";
import { oneCost } from "./pricing.js";

const FEISHU_SESSION_DIR = "--home-feishu--";
const FEISHU_SESSION_FILE = "feishu.jsonl";

export class PiSessionManager {
  private session: AgentSession | null = null;
  private sessionFile: string = "";
  private isProcessing = false;
  private abortCurrent?: () => void;
  private processingStartTime: number = 0;
  /** 当前正在执行的工具，如 "bash: ls src/" */
  currentTool: string = "";
  private _model: string = "";
  /** 最近一次 agent_end 事件的 messages，用于统计 */
  private lastMessages: any[] | null = null;
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;

  constructor(private config: BridgeConfig) {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  /** 获取或创建飞书 session */
  async getSession(): Promise<AgentSession> {
    if (this.session) return this.session;
    return this.createSession();
  }

  /** /new：归档旧会话，创建新会话（不删除任何数据） */
  async resetSession(): Promise<{ success: boolean; error?: string }> {
    // 中止当前处理
    if (this.isProcessing && this.abortCurrent) {
      this.abortCurrent();
    }

    // 释放当前 session
    if (this.session) {
      this.session.dispose();
      this.session = null;
      this.isProcessing = false;
    }

    // 归档旧会话文件（如果存在且有内容）
    if (this.sessionFile && existsSync(this.sessionFile)) {
      const content = readFileSync(this.sessionFile, "utf-8").trim();
      if (content) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const archived = this.sessionFile.replace(".jsonl", `_${timestamp}.jsonl`);
        try {
          renameSync(this.sessionFile, archived);
          console.log(`[会话] 已归档: ${archived}`);
        } catch (err) {
          return { success: false, error: `归档失败: ${err}` };
        }
      }
    }

    return { success: true };
  }

  /** 中止当前处理（对应 /stop 命令） */
  abortProcessing(): boolean {
    if (this.isProcessing && this.abortCurrent) {
      this.abortCurrent();
      return true;
    }
    return false;
  }

  /** 压缩上下文（对应 /compact 命令） */
  async compactSession(): Promise<{ success: boolean; error?: string }> {
    if (!this.session) {
      return { success: false, error: "没有活跃的会话" };
    }
    try {
      await this.session.compact();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /** 发送 prompt 并监听结果（飞书特有流式回调） */
  async prompt(
    text: string,
    callbacks: {
      onDelta: (delta: string) => void;
      /** 思考内容流（模型内部推理） */
      onThinking?: (text: string) => void;
      /** 工具执行事件: start/end/thinking, 参数 toolName, args/result */
      onToolEvent?: (event: { type: "tool_start" | "tool_end" | "thinking"; toolName: string; detail: string }) => void;
      onDone: () => void;
      onError: (err: string) => void;
    },
  ): Promise<{ abort: () => void }> {
    const session = await this.getSession();
    const { onDelta, onThinking, onToolEvent, onDone, onError } = callbacks;
    let finished = false;
    let thinkingCaptured = false;

    this.isProcessing = true;
    this.processingStartTime = Date.now();
    this.currentTool = "等待 LLM 响应...";

    // 空闲超时：每次有活动重置
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastActivity = Date.now();

    const resetIdleTimer = () => {
      lastActivity = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (finished) return;
        const elapsed = Date.now() - lastActivity;
        if (elapsed >= this.config.timeout) {
          finished = true;
          unsub();
          this.isProcessing = false;
          session.abort();
          onError(`⏱️ 任务已空闲 ${(this.config.timeout / 1000).toFixed(0)} 秒无响应，已中止。可发送 /new 重建会话`);
        }
      }, this.config.timeout + 100);
    };

    resetIdleTimer();

    // Delta 批处理：积累 delta，定期刷新
    let deltaBuffer = "";
    let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDelta = () => {
      if (deltaBuffer) {
        onDelta(deltaBuffer);
        deltaBuffer = "";
      }
    };
    const scheduleFlush = () => {
      if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
      deltaFlushTimer = setTimeout(flushDelta, 500); // 每 500ms 刷新一次
    };

    const unsub = session.subscribe((event) => {
      if (finished) return;
      resetIdleTimer();

      switch (event.type) {
        case "message_start": {
          // 消息开始时，尝试捕获思考内容
          if (!thinkingCaptured && onThinking) {
            const msg = (event as any).message;
            if (msg?.content && Array.isArray(msg.content)) {
              const thinkBlock = msg.content.find((c: any) => c.type === "thinking");
              if (thinkBlock?.thinking) {
                thinkingCaptured = true;
                onThinking(thinkBlock.thinking);
              }
            }
          }
          break;
        }

        case "message_update":
          // 尝试捕获思考内容（message_start 没抓到的话）
          if (!thinkingCaptured && onThinking) {
            const msg = (event as any).message;
            if (msg?.content && Array.isArray(msg.content)) {
              const thinkBlock = msg.content.find((c: any) => c.type === "thinking");
              if (thinkBlock?.thinking) {
                thinkingCaptured = true;
                onThinking(thinkBlock.thinking);
              }
            }
          }
          // 累积 delta 而非立即推送
          if ("assistantMessageEvent" in event &&
              event.assistantMessageEvent?.type === "text_delta") {
            deltaBuffer += event.assistantMessageEvent.delta;
            scheduleFlush();
          }
          break;

        case "tool_execution_start": {
          const args = (event as any).args || {};
          const argStr = Object.values(args).filter(Boolean).join(" ").slice(0, 80);
          this.currentTool = `${event.toolName}: ${argStr}`;
          onToolEvent?.({ type: "tool_start", toolName: event.toolName, detail: argStr });
          break;
        }

        case "tool_execution_end": {
          this.currentTool = "";
          const isErr = (event as any).isError;
          onToolEvent?.({ type: "tool_end", toolName: event.toolName, detail: isErr ? "❌" : "✅" });
          break;
        }

        case "turn_start":
          onToolEvent?.({ type: "thinking", toolName: "", detail: "" });
          break;

        case "agent_end":
          finished = true;
          unsub();
          if (idleTimer) clearTimeout(idleTimer);
          this.isProcessing = false;
          this.currentTool = "";
          if ("messages" in event) {
            this.lastMessages = (event as any).messages;
          }
          flushDelta();
          if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
          onDone();
          return;
        case "turn_end":
          flushDelta();
          break;
        case "agent_start":
          flushDelta();
          break;
      }
    });

    const abortFn = () => {
      if (finished) return;
      finished = true;
      unsub();
      if (idleTimer) clearTimeout(idleTimer);
      if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
      flushDelta();
      this.isProcessing = false;
      session.abort();
    };
    this.abortCurrent = abortFn;

    try {
      console.log(`[prompt] 发送中... 流式: ${session.isStreaming}`);
      if (session.isStreaming) {
        await session.steer(text);
      } else {
        await session.prompt(text);
      }
    } catch (err) {
      if (!finished) {
        finished = true;
        unsub();
        if (idleTimer) clearTimeout(idleTimer);
        this.isProcessing = false;
        const errMsg = String(err);
        if (errMsg.includes("context") || errMsg.includes("token") || errMsg.includes("length")) {
          onError("📦 上下文已满，请发送 /new 开始新会话，或发送 /compact 压缩后继续");
        } else {
          onError(`❌ ${errMsg}`);
        }
      }
      return { abort: () => {} };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }

    return { abort: abortFn };
  }

  /** 计算当日所有会话总费用 */
  calcTodayCost(): number {
    const today = new Date().toISOString().slice(0, 10);
    let total = 0;
    try {
      const dir = this.getSessionDir();
      if (!existsSync(dir)) return 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        try {
          for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
            if (!line.trim()) continue;
            const e = JSON.parse(line);
            if (e.type !== "message" || e.message?.role !== "assistant") continue;
            const ts = e.timestamp || e.message?.timestamp;
            if (!ts || !new Date(ts).toISOString().startsWith(today)) continue;
            const u = e.message.usage;
            if (!u) continue;
            total += oneCost(e.message.model || "", u.input || 0, u.output || 0, u.cacheRead || 0);
          }
        } catch {}
      }
    } catch {}
    return Math.round(total * 1_000_000) / 1_000_000;
  }

  /** 获取当前会话用量统计 */
  getUsageStats(): { totalInput: number; totalOutput: number; totalCache: number; turns: number; cost: number } {
    const msgs = this.lastMessages;
    if (!msgs || msgs.length === 0) return { totalInput: 0, totalOutput: 0, totalCache: 0, turns: 0, cost: 0 };

    let totalInput = 0, totalOutput = 0, totalCache = 0, turns = 0;
    let curCost = 0;
    let lastModel = "";
    for (const m of msgs) {
      if (m.role === "assistant") {
        turns++;
        lastModel = m.model || lastModel;
        if (m.usage) {
          const u = m.usage;
          totalInput += (u.input || 0) + (u.cacheRead || 0);
          totalOutput += u.output || 0;
          totalCache += u.cacheRead || 0;
          // 用与 cny-cost 相同的定价公式
          curCost += oneCost(lastModel, u.input || 0, u.output || 0, u.cacheRead || 0);
        }
      }
    }
    // 保留 6 位小数
    curCost = Math.round(curCost * 1_000_000) / 1_000_000;
    return { totalInput, totalOutput, totalCache, turns, cost: curCost };
  }

  getStatus() {
    const msgs = this.lastMessages;
    let model = "";
    if (msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant" && msgs[i].model) {
          model = msgs[i].model;
          break;
        }
      }
    }
    return {
      hasSession: this.session !== null,
      isProcessing: this.isProcessing,
      currentTool: this.currentTool,
      runningFor: this.isProcessing ? ((Date.now() - this.processingStartTime) / 1000).toFixed(0) + "s" : "-",
      sessionFile: this.sessionFile || null,
      model,
    };
  }

  dispose() {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
  }

  // ─── 私有方法 ──────────────────────────────────────────

  /** 飞书 session 存储目录：~/.pi/agent/sessions/--home-feishu--/ */
  private getSessionDir(): string {
    if (this.config.sessionsDir) return this.config.sessionsDir;
    return join(homedir(), ".pi", "agent", "sessions", FEISHU_SESSION_DIR);
  }

  private async createSession(): Promise<AgentSession> {
    const workDir = process.cwd();

    const sessionDir = this.getSessionDir();
    mkdirSync(sessionDir, { recursive: true });

    this.sessionFile = join(sessionDir, FEISHU_SESSION_FILE);

    const { session } = await createAgentSession({
      cwd: workDir,
      sessionManager: SessionManager.open(this.sessionFile),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });

    this.session = session;
    console.log(`[会话] 飞书 session: ${this.sessionFile}`);

    return session;
  }
}
