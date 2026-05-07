/**
 * 桥接服务主逻辑
 * 连接飞书 WebSocket ↔ pi AgentSession
 *
 * 飞书消息通过简短文本回复标记状态:
 *   👀 → [AI 回复] → ✅ 完成 (含用量统计)
 */

import { createServer } from "node:http";
import type { BridgeConfig } from "./config.js";
import { FeishuClient } from "./feishu-client.js";
import { PiSessionManager, readPromptFile, readMemoryFile } from "./session-manager.js";
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
          sessions: this.sessionManager.getStats(),
        }));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
  }

  async start(): Promise<void> {
    const { config } = this;

    if (!config.feishuAppId || !config.feishuAppSecret) {
      console.error("❌ 请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量");
      process.exit(1);
    }

    await this.feishu.start();

    this.httpServer.listen(config.port, "127.0.0.1", () => {
      console.log(`[健康检查] http://127.0.0.1:${config.port}/health`);
    });

    this.registerShutdown();

    const prompt = readPromptFile();
    const memory = readMemoryFile();
    if (prompt) console.log(`[提示词] 已加载 (${prompt.length} 字符)`);
    if (memory) console.log(`[记忆]   已加载 (${memory.length} 字符)`);

    console.log("\n✅ 飞书 ↔ pi 桥接服务已启动");
    console.log(`   模型: ${config.model}`);
    console.log(`   超时: ${config.timeout / 1000}s`);
    console.log("   命令: /new /stop /compact /help");
  }

  private async handleMessage(source: FeishuSource, text: string) {
    console.log(
      `[消息] ${source.chatType === "p2p" ? "私聊" : "群聊"} ` +
      `来自 ${source.senderName}: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`
    );

    const sessionKey = source.chatType === "group"
      ? `group_${source.chatId}`
      : `user_${source.senderId}`;

    const cmd = text.trim().toLowerCase();

    // ─── 命令 ──────────────────────────────────────────────
    if (cmd === "/new") {
      const r = await this.sessionManager.resetSession(sessionKey);
      await this.feishu.replyMarkdown(source, r.success ? "✅ 会话已重置" : `❌ 重置失败: ${r.error}`);
      return;
    }
    if (cmd === "/stop") {
      const aborted = this.sessionManager.abortProcessing(sessionKey);
      await this.feishu.replyMarkdown(source, aborted ? "⏹ 已中止" : "ℹ️ 无处理中的任务");
      return;
    }
    if (cmd === "/compact") {
      await this.sessionManager.getOrCreate(sessionKey, source.chatId);
      const r = await this.sessionManager.compactSession(sessionKey);
      await this.feishu.replyMarkdown(source, r.success ? "✅ 上下文已压缩" : `❌ 压缩失败: ${r.error}`);
      return;
    }
    if (cmd === "/help") {
      const p = readPromptFile();
      const m = readMemoryFile();
      await this.feishu.replyMarkdown(source,
        "**飞书桥接使用帮助**\n\n" +
        "发送消息给机器人即可对话。\n\n" +
        "**命令:**\n  /new /stop /compact /help\n\n" +
        "提示词: " + (p ? "✅" : "❌") + "\n记忆:   " + (m ? "✅" : "❌")
      );
      return;
    }

    // ─── 普通消息 ──────────────────────────────────────────
    const session = await this.sessionManager.getOrCreate(sessionKey, source.chatId);
    const enrichedText = this.sessionManager.buildMessage(text);

    // 👀 开始处理
    await this.feishu.replyProcessing(source);

    // 收集 AI 回复
    let replyContent = "";

    await this.sessionManager.prompt(session, enrichedText, {
      onDelta: (delta: string) => { replyContent += delta; },
      onDone: async () => {
        // 先发 AI 回复内容
        if (replyContent) {
          await this.feishu.replyMarkdown(source, replyContent);
        }

        // 从 session 取用量统计，放 ✅ 消息里
        const usageLine = getUsageLine(session);
        await this.feishu.replyMarkdown(source, `✅ 完成  ${usageLine || ""}`);

        console.log(`[完成] ${source.senderName}: ${text.slice(0, 40)}`);
      },
      onError: async (err: string) => {
        console.error(`[错误] ${err}`);
        if (replyContent) {
          await this.feishu.replyMarkdown(source, replyContent + `\n\n---\n❌ ${err}`);
        } else {
          await this.feishu.replyError(source, err);
        }
      },
    }, sessionKey);
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

/** 从 session 最近的 assistant 消息提取用量摘要 */
function getUsageLine(session: any): string {
  try {
    const msgs = session.messages as any[];
    // 找最后一个 assistant 消息
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "assistant" && m.usage) {
        const u = m.usage;
        const parts: string[] = [];
        if (u.input > 0) parts.push(`↑${fmt(u.input)}`);
        if (u.output > 0) parts.push(`↓${fmt(u.output)}`);
        if (u.cacheRead > 0) parts.push(`⚡${fmt(u.cacheRead)}`);
        if (u.totalTokens > 0) parts.push(`∑${fmt(u.totalTokens)}`);
        if (u.cost?.total > 0) parts.push(`¥${u.cost.total.toFixed(3)}`);
        return parts.join(" ");
      }
    }
  } catch {}
  return "";
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
