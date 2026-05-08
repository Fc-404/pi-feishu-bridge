/**
 * 桥接服务主逻辑
 *
 * 设计理念：飞书就是 pi 的远程终端。
 * - 同一个工作目录、同一个 AGENTS.md、同一个 session
 * - 无用户隔离、无工作区沙箱
 * - 支持所有 pi 命令（/new /compact 等由 session 处理）
 * - 额外功能：流式回复 + 完成通知 + 用量统计
 */

import { createServer } from "node:http";
import type { BridgeConfig } from "./config.js";
import { FeishuClient } from "./feishu-client.js";
import { PiSessionManager } from "./session-manager.js";
import type { FeishuSource } from "./types.js";

export class BridgeServer {
  private feishu: FeishuClient;
  private sessionManager: PiSessionManager;
  private httpServer: ReturnType<typeof createServer>;

  constructor(private config: BridgeConfig) {
    this.feishu = new FeishuClient(config);
    this.sessionManager = new PiSessionManager(config);
    this.feishu.onMessage((source, text) => this.handleMessage(source, text));

    this.httpServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          uptime: process.uptime(),
          session: this.sessionManager.getStatus(),
        }));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
  }

  async start(): Promise<void> {
    const { config } = this;

    console.log("\n═══════════════════════════════════════");
    console.log("  飞书桥接 v2 — 统一 pi session");
    console.log("═══════════════════════════════════════");

    if (!config.feishuAppId || !config.feishuAppSecret) {
      console.error("❌ 请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量");
      process.exit(1);
    }

    await this.feishu.start();

    this.httpServer.listen(config.port, "127.0.0.1", () => {
      console.log(`[健康检查] http://127.0.0.1:${config.port}/health`);
    });

    this.registerShutdown();

    console.log("\n✅ 飞书 ↔ pi 桥接服务已启动");
    console.log(`   工作目录: ${process.cwd()}`);
    console.log(`   模型: ${config.model}`);
    console.log(`   超时: ${config.timeout / 1000}s`);
    console.log("   命令: /new /stop /compact /help");
    console.log("   提示: 项目中的 AGENTS.md 会自动加载");
  }

  private async handleMessage(source: FeishuSource, text: string) {
    console.log(
      `[消息] ${source.chatType === "p2p" ? "私聊" : "群聊"} ` +
      `来自 ${source.senderName}: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`
    );

    const cmd = text.trim().toLowerCase();

    // ─── 本地命令 ─────────────────────────────────────────
    if (cmd === "/new") {
      const r = await this.sessionManager.resetSession();
      await this.feishu.replyMarkdown(source, r.success ? "✅ 会话已重置" : `❌ 重置失败: ${r.error}`);
      return;
    }
    if (cmd === "/stop") {
      const aborted = this.sessionManager.abortProcessing();
      await this.feishu.replyMarkdown(source, aborted ? "⏹ 已中止" : "ℹ️ 无处理中的任务");
      return;
    }
    if (cmd === "/compact") {
      const r = await this.sessionManager.compactSession();
      await this.feishu.replyMarkdown(source, r.success ? "✅ 上下文已压缩" : `❌ 压缩失败: ${r.error}`);
      return;
    }
    if (cmd === "/status") {
      const st = this.sessionManager.getStatus();
      const stats = this.sessionManager.getUsageStats();
      const todayCost = this.sessionManager.calcTodayCost();

      const lines = [
        "**🤖 桥接状态**",
        "",
        `处理中: ${st.isProcessing ? "🟢 是" : "🔴 否"}`,
        st.currentTool ? `当前操作: \`${st.currentTool}\`` : "",
        st.isProcessing ? `已运行: ${st.runningFor}` : "",
        `模型: ${st.model || "未知"}`,
        "",
        "**当前会话统计:**",
        `  ↑${fmt(stats.totalInput)} ↓${fmt(stats.totalOutput)}`,
        `  ⚡${fmt(stats.totalCache)}/${fmt(stats.totalInput - stats.totalCache)}`,
        `  🔄${stats.turns} 次调用`,
        `  ¥${fmtCost(stats.cost)}`,
        "",
        `**今日总费用:** ¥${fmtCost(todayCost)}`,
        "",
        "**命令:** /new /stop /compact /help",
      ].filter(Boolean).join("\n");

      await this.feishu.replyMarkdown(source, lines);
      return;
    }

    if (cmd === "/help") {
      await this.feishu.replyMarkdown(source,
        "**飞书 ↔ pi 桥接**\n\n" +
        "像在 pi TUI 中一样对话即可。\n\n" +
        "**命令:**\n" +
        "  /new     重置会话\n" +
        "  /stop    中止当前回复\n" +
        "  /compact 压缩上下文\n" +
        "  /help    显示此帮助\n\n" +
        "**提示:**\n" +
        "- AGENTS.md 自动加载到系统提示词\n" +
        "- 项目配置（.pi/）与 pi 完全共享\n" +
        "- 记忆文件可通过对话让 AI 更新"
      );
      return;
    }

    // ─── 发送到 pi session ────────────────────────────────
    const session = await this.sessionManager.getSession();

    // 检查是否正在处理
    if (session.isStreaming) {
      await this.feishu.replyMarkdown(source, "⏳ 前一个问题正在处理中，请稍后再发\n（或发送 /stop 中止当前任务）");
      return;
    }

    // 👀 文本 + 完成后 👏/😢 表情
    console.log(`[发送] 正在发送给 LLM: ${text.slice(0, 60)}`);
    await this.feishu.replyProcessing(source);

    // 收集 AI 回复
    let replyContent = "";

    await this.sessionManager.prompt(text, {
      onDelta: (delta: string) => { replyContent += delta; },
      onDone: async () => {
        console.log(`[完成] AI 回复长度: ${replyContent.length} 字符`);
        // 👏 表情标记完成
        await this.feishu.reactDone(source.messageId);
        // AI 回复内容
        if (replyContent) {
          await this.feishu.replyMarkdown(source, replyContent);
        }
      },
      onError: async (err: string) => {
        console.error(`[错误] ${err}`);
        // 😢 表情标记错误
        await this.feishu.reactError(source.messageId);
        if (replyContent) {
          await this.feishu.replyMarkdown(source, replyContent + `\n\n---\n❌ ${err}`);
        } else {
          await this.feishu.replyError(source, err);
        }
      },
    });
  }

  private registerShutdown() {
    const shutdown = async () => {
      console.log("\n[关闭] 正在清理...");
      this.sessionManager.dispose();
      await this.feishu.stop();
      this.httpServer.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

function fmt(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  if (n >= 1) return n.toFixed(3);
  // 小于1元显示足够精度
  return n.toFixed(6);
}

/** 格式化金额，小数值保留足够精度 */
function fmtCost(n: number): string {
  if (n >= 0.01) return n.toFixed(3);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(6);
}
