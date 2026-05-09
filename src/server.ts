/**
 * 飞书桥接服务核心逻辑
 * 处理飞书消息 → pi session 的发送、回复、命令处理
 */

import { FeishuClient } from "./feishu-client.js";
import { PiSessionManager } from "./session-manager.js";
import type { BridgeConfig } from "./config.js";
import type { FeishuSource } from "./types.js";

/** 报告服务地址 */
const REPORT_SERVER = process.env.REPORT_SERVER_URL || "http://127.0.0.1:9779";
const API_KEY = process.env.REPORT_SERVER_API_KEY || "report-push-key-2024";

/** 直播会话信息 */
interface LiveSession {
  sessionId: string;
  url: string;
}

/** 格式化 token 数量 */
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/** 格式化费用（元） */
function fmtCost(n: number): string {
  if (n >= 100) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  if (n === 0) return "0";
  return n.toFixed(4);
}

// ─── 直播会话辅助 ────────────────────────────────────────

/** 频率限制：同一 live session 每秒最多推送 N 次 */
const liveThrottleMs = 300;
const liveLastPush: Map<string, number> = new Map();

async function pushLive(live: LiveSession | null, type: string, content: string) {
  if (!live) return;
  const now = Date.now();
  const last = liveLastPush.get(live.sessionId) || 0;
  if (now - last < liveThrottleMs) return;
  liveLastPush.set(live.sessionId, now);

  try {
    await fetch(`${REPORT_SERVER}/api/live/${live.sessionId}/append`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ type, content }),
    });
  } catch {}
}

async function liveDone(live: LiveSession | null, totalSec: string, finalContent: string, isError: boolean) {
  if (!live) return;
  try {
    await fetch(`${REPORT_SERVER}/api/live/${live.sessionId}/done`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ total_time: parseFloat(totalSec), final_content: finalContent, error: isError }),
    });
  } catch {}
}

export class BridgeServer {
  private feishu: FeishuClient;
  private sessionManager: PiSessionManager;

  constructor(private config: BridgeConfig) {
    this.feishu = new FeishuClient(this.config);
    this.sessionManager = new PiSessionManager(this.config);
    this.feishu.onMessage((source, text) => this.handleMessage(source, text));
  }

  async start(): Promise<void> {
    this.registerShutdown();
    await this.feishu.start();
  }

  private async handleMessage(source: FeishuSource, text: string) {
    // ─── 命令处理（在 LLM 之前立即处理） ────────────────
    if (text.startsWith("/")) {
      console.log(`[命令] ${source.senderName}: ${text}`);
      await this.handleCommand(source, text);
      return;
    }

    const session = await this.sessionManager.getSession();

    if (session.isStreaming) {
      await this.feishu.replyMarkdown(source, "⏳ 前一个问题正在处理中，请稍后再发\n（或发送 /stop 中止当前任务）");
      return;
    }

    console.log(`[发送] 正在发送给 LLM: ${text.slice(0, 60)}`);

    // ─── 计时 & 状态 ──────────────────────────────────
    const totalStart = Date.now();
    let replyContent = "";
    let liveSession: LiveSession | null = null;

    await this.feishu.reactGet(source);

    // ─── 创建直播会话 ─────────────────────────────────
    try {
      const resp = await fetch(`${REPORT_SERVER}/api/live/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ title: "LLM 实时进度" }),
      });
      if (resp.ok) {
        const data = await resp.json();
        liveSession = { sessionId: data.session_id, url: data.url };
      }
    } catch {}

    if (liveSession) {
      await this.feishu.replyMarkdown(source, `📡 实时进度: ${liveSession.url}`);
    }

    await this.sessionManager.prompt(text, {
      onThinking: (thinking: string) => {
        pushLive(liveSession, "thinking", thinking);
      },
      onDelta: (delta: string) => {
        replyContent += delta;
        // delta 不推 live，避免碎片化和重复
      },
      onToolEvent: async (evt: { type: string; toolName: string; detail: string }) => {
        if (evt.type === "tool_start") {
          const toolDetail = `${evt.toolName}: ${evt.detail}`;
          pushLive(liveSession, "tool", toolDetail);
        }
      },
      onDone: async () => {
        const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1);
        const finalText = replyContent
          ? replyContent + `\n\n⏱ ${totalSec}s`
          : `完成 (⏱ ${totalSec}s)`;
        await this.feishu.replyWithDONE(source, finalText);
        await liveDone(liveSession, totalSec, finalText, false);
      },
      onError: async (err: string) => {
        const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1);
        const finalText = replyContent
          ? replyContent + `\n\n---\n❌ ${err}\n⏱ ${totalSec}s`
          : `❌ ${err} (⏱ ${totalSec}s)`;
        await this.feishu.replyWithClownFace(source, finalText);
        await liveDone(liveSession, totalSec, finalText, true);
      },
    });
  }

  private async handleCommand(source: FeishuSource, text: string) {
    const cmd = text.split(/\s+/);
    const cmdName = cmd[0].toLowerCase();
    const args = cmd.slice(1);

    switch (cmdName) {
      case "/new": {
        this.sessionManager.resetSession();
        await this.feishu.replyMarkdown(source, "🆕 会话已重置，开启全新对话");
        break;
      }

      case "/stop": {
        const session = await this.sessionManager.getSession();
        if (session.isStreaming) {
          session.abort();
          setTimeout(async () => {
            await this.feishu.replyMarkdown(source, "⏹️ 已中止 LLM 生成");
          }, 100);
        } else {
          await this.feishu.replyMarkdown(source, "ℹ️ 当前没有正在进行的任务");
        }
        break;
      }

      case "/compact": {
        const result = await this.sessionManager.compactSession();
        if (result.success) {
          await this.feishu.replyMarkdown(source, "🗜️ 已压缩上下文历史（关闭时间线）");
        } else {
          await this.feishu.replyMarkdown(source, `ℹ️ 上下文未压缩: ${result.error || "未知错误"}`);
        }
        break;
      }

      case "/status": {
        const session = await this.sessionManager.getSession();
        const stats = this.sessionManager.getUsageStats();
        const todayCost = this.sessionManager.calcTodayCost();

        const lines: string[] = [
          "**📊 当前状态**",
          "",
          `- 会话消息数: **${session.messages.length}**`,
          `- 总输入 token: **${fmt(stats.totalInput)}**`,
          `- 总输出 token: **${fmt(stats.totalOutput)}**`,
          `- 缓存命中: **${fmt(stats.totalCache)}**`,
          `- 上下文轮次: **${stats.turns}**`,
          `- 累计费用: **¥${fmtCost(stats.cost)}**`,
          `- 今日累计: **¥${fmtCost(todayCost)}**`,
          session.isStreaming ? "\n🔄 **LLM 正在生成中...**" : "\n💤 **空闲中**",
        ];

        await this.feishu.replyMarkdown(source, lines.join("\n"));
        break;
      }

      case "/help":
        await this.feishu.replyMarkdown(source,
          "**🤖 pi 飞书桥接命令**\n\n" +
          "  /new      重置会话，开始全新对话\n" +
          "  /stop     中止当前 LLM 生成\n" +
          "  /compact  压缩上下文历史\n" +
          "  /status   查看用量和费用统计\n" +
          "  /help     显示此帮助\n\n" +
          "**提示:**\n" +
          "- 实时进度通过 report 页面查看\n" +
          "- 项目配置（.pi/）与 pi 完全共享\n" +
          "- 记忆文件可通过对话让 AI 更新"
        );
        break;

      default:
        await this.feishu.replyMarkdown(source, `⚠️ 未知命令: ${cmdName}\n发送 /help 查看可用命令`);
    }
  }

  private registerShutdown() {
    const shutdown = async () => {
      console.log("\n[关闭] 正在清理...");
      this.sessionManager.dispose();
      await this.feishu.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
