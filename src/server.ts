/**
 * 飞书桥接服务核心逻辑
 * 处理飞书消息 → pi session 的发送、回复、命令处理
 */

import { FeishuClient } from "./feishu-client.js";
import { PiSessionManager } from "./session-manager.js";
import type { BridgeConfig } from "./config.js";
import type { FeishuSource } from "./types.js";

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
    let thinkingStart = 0;
    let thinkingMsgId: string | undefined;
    let toolStart = 0;
    let toolMsgId: string | undefined;
    let toolText = "";
    let replyContent = "";

    await this.feishu.reactGet(source);

    await this.sessionManager.prompt(text, {
      onDelta: (delta: string) => { replyContent += delta; },
      onToolEvent: async (evt: { type: string; toolName: string; detail: string }) => {
        if (evt.type === "thinking") {
          // 新思考轮次开始
          thinkingStart = Date.now();
          if (!thinkingMsgId) {
            // 首次思考: 发 "💭 思考中..."
            thinkingMsgId = await this.feishu.sendThinking(source);
          }
          // 非首次: 不发新消息，沿用已有的

        } else if (evt.type === "tool_start") {
          // 思考结束 → 编辑思考消息带耗时
          if (thinkingMsgId && thinkingStart) {
            await this.feishu.editThinkingDone(thinkingMsgId, Date.now() - thinkingStart);
          }
          // 工具开始
          toolStart = Date.now();
          toolText = `🔧 **${evt.toolName}**: ${evt.detail}`;
          toolMsgId = await this.feishu.sendToolRunning(source, toolText);

        } else if (evt.type === "tool_end") {
          // 工具结束 → 编辑工具消息带耗时
          if (toolMsgId && toolStart) {
            const elapsed = ((Date.now() - toolStart) / 1000).toFixed(1);
            await this.feishu.editText(toolMsgId, `${toolText} (${elapsed}s)`);
          }
          toolMsgId = undefined;
        }
      },
      onDone: async () => {
        // 最后一段思考的耗时
        if (thinkingMsgId && thinkingStart) {
          await this.feishu.editThinkingDone(thinkingMsgId, Date.now() - thinkingStart);
        }
        const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1);
        const finalText = replyContent
          ? replyContent + `\n\n⏱ ${totalSec}s`
          : `完成 (⏱ ${totalSec}s)`;
        await this.feishu.replyWithDONE(source, finalText);
      },
      onError: async (err: string) => {
        if (thinkingMsgId && thinkingStart) {
          await this.feishu.editThinkingDone(thinkingMsgId, Date.now() - thinkingStart);
        }
        const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1);
        const finalText = replyContent
          ? replyContent + `\n\n---\n❌ ${err}\n⏱ ${totalSec}s`
          : `❌ ${err} (⏱ ${totalSec}s)`;
        await this.feishu.replyWithClownFace(source, finalText);
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
          "- AGENTS.md 自动加载到系统提示词\n" +
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
