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
    // session 路径由 PiSessionManager 构造时自动确保
    // 注册 shutdown
    this.registerShutdown();
    await this.feishu.start();
  }

  private async handleMessage(source: FeishuSource, text: string) {
    // ─── 命令处理（必须在 LLM 之前立即处理） ────────────
    if (text.startsWith("/")) {
      console.log(`[命令] ${source.senderName}: ${text}`);
      await this.handleCommand(source, text);
      return;
    }

    // ─── 链式表情回复 ───
    // 1. Get 在用户消息上（已收到）
    // 2. 💭 思考中... + StatusFlashOfInspiration（bot 初始回复）
    // 3. 🔧 tool + Typing（可选，执行命令时）
    // 4. AI 内容编辑替换原始思考消息 + DONE

    const session = await this.sessionManager.getSession();

    // 检查是否正在处理
    if (session.isStreaming) {
      await this.feishu.replyMarkdown(source, "⏳ 前一个问题正在处理中，请稍后再发\n（或发送 /stop 中止当前任务）");
      return;
    }

    console.log(`[发送] 正在发送给 LLM: ${text.slice(0, 60)}`);
    await this.feishu.reactGet(source);  // Get 在用户消息

    let replyContent = "";
    let thinkingMsgId: string | undefined;
    let thinkingSent = false;

    await this.sessionManager.prompt(text, {
      onDelta: (delta: string) => { replyContent += delta; },
      onToolEvent: async (evt: { type: string; toolName: string; detail: string }) => {
        if (evt.type === "thinking" && !thinkingSent) {
          thinkingSent = true;
          thinkingMsgId = await this.feishu.sendThinking(source);  // 💭 + StatusFlashOfInspiration
        } else if (evt.type === "tool_start") {
          // 如果还没发思考消息，先发
          if (!thinkingSent) {
            thinkingSent = true;
            thinkingMsgId = await this.feishu.sendThinking(source);
          }
          // 发工具执行消息 + Typing
          await this.feishu.sendToolRunning(source, `🔧 **${evt.toolName}**: ${evt.detail}`);
        }
      },
      onDone: async () => {
        console.log(`[完成] AI 回复长度: ${replyContent.length} 字符`);
        const finalText = replyContent || "完成";
        if (thinkingMsgId) {
          // 编辑原始思考消息 → AI 内容 + DONE
          await this.feishu.finishMessage(thinkingMsgId, finalText);
        } else if (replyContent) {
          // 没有中间消息，直接发
          await this.feishu.replyMarkdown(source, replyContent);
        }
      },
      onError: async (err: string) => {
        console.error(`[错误] ${err}`);
        const finalText = replyContent ? replyContent + `\n\n---\n❌ ${err}` : `❌ ${err}`;
        if (thinkingMsgId) {
          await this.feishu.failMessage(thinkingMsgId, finalText);
        } else {
          await this.feishu.replyMarkdown(source, finalText);
        }
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
          // 给 LLM 一点时间处理 abort
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
