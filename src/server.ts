/**
 * 桥接服务主逻辑
 * 连接飞书 WebSocket ↔ pi AgentSession
 *
 * 飞书消息通过表情反应 (Reaction) 标记状态:
 *   👀 处理中  →  ✅ 完成  /  ❌ 错误
 * 命令回复使用文本消息。
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
    console.log(`[文件]   .pi/feishu-prompt.md  .pi/feishu-memory.md`);

    console.log("\n✅ 飞书 ↔ pi 桥接服务已启动");
    console.log(`   模型: ${config.model}`);
    console.log(`   超时: ${config.timeout / 1000}s`);
    console.log("");
    console.log("   发送消息给机器人，通过表情反应查看状态:");
    console.log("   👀 处理中 → ✅ 完成 / ❌ 错误");
    console.log("   命令: /new /stop /compact /help (文本回复)");
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

    // ─── 命令：文本回复 ────────────────────────────────────
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
        "发送消息给机器人，通过表情反应查看状态：\n" +
        "  👀 处理中 → ✅ 完成 / ❌ 错误\n\n" +
        "**命令:**\n" +
        "  /new     重建会话\n  /stop    中止处理\n" +
        "  /compact 压缩上下文\n  /help    帮助\n\n" +
        "提示词: " + (p ? `✅` : "❌") + "\n" +
        "记忆:   " + (m ? `✅` : "❌")
      );
      return;
    }

    // ─── 普通消息：用 Reaction 标记状态 ────────────────────
    const session = await this.sessionManager.getOrCreate(sessionKey, source.chatId);
    const enrichedText = this.sessionManager.buildMessage(text);

    // 👀 标记处理中
    await this.feishu.markProcessing(source.messageId);

    await this.sessionManager.prompt(session, enrichedText, {
      onDelta: () => { /* 不需要流式回复 */ },
      onDone: async () => {
        // ✅ 标记完成
        await this.feishu.markDone(source.messageId);
        console.log(`[完成] ${source.senderName}: ${text.slice(0, 40)}`);
      },
      onError: async (err: string) => {
        // ❌ 标记错误
        console.error(`[错误] ${err}`);
        await this.feishu.markError(source.messageId);
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
