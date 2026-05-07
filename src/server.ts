/**
 * 桥接服务主逻辑
 * 连接飞书 WebSocket ↔ pi AgentSession
 *
 * 飞书消息支持的命令:
 *   /new    - 重建会话（清空上下文）
 *   /stop   - 中止当前处理
 *   /help   - 查看帮助
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

    // 健康检查 HTTP
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

    console.log("\n✅ 飞书 ↔ pi 桥接服务已启动");
    console.log(`   模型: ${config.model}`);
    console.log(`   超时: ${config.timeout / 1000}s`);
    console.log(`   会话目录: ${config.sessionsDir}`);
    console.log(`   工作目录: ${config.workspacesDir}`);
    console.log("");
    console.log("   给飞书机器人发消息即可开始对话！");
    console.log("   支持命令: /new (重建会话)  /stop (中止)  /help (帮助)");
  }

  private async handleMessage(source: FeishuSource, text: string) {
    console.log(
      `[消息] ${source.chatType === "p2p" ? "私聊" : "群聊"} ` +
      `来自 ${source.senderName}: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`
    );

    const sessionKey = source.chatType === "group"
      ? `group_${source.chatId}`
      : `user_${source.senderId}`;

    // ─── 处理飞书命令 ──────────────────────────────────────
    const cmd = text.trim().toLowerCase();

    if (cmd === "/new") {
      const result = await this.sessionManager.resetSession(sessionKey);
      if (result.success) {
        await this.feishu.replyMarkdown(source, "✅ **会话已重置**，您可以开始新的对话了。");
      } else {
        await this.feishu.replyMarkdown(source, `❌ **重置失败**: ${result.error}`);
      }
      return;
    }

    if (cmd === "/stop") {
      if (this.sessionManager.isProcessing(sessionKey)) {
        // prompt 的 abort 由超时处理，这里发一条中止指令
        // 实际 abort 由 session-manager 的超时机制处理
        // 我们直接抛出一个中止信号
        await this.feishu.replyMarkdown(source, "⏹ **正在中止**当前处理...");
        // 重置 session 以强制中止
        await this.sessionManager.resetSession(sessionKey);
        // 重新创建 session 以备下次使用
        await this.sessionManager.getOrCreate(sessionKey, source.chatId);
        await this.feishu.replyMarkdown(source, "⏹ **已中止**，可以继续发送新消息。");
      } else {
        await this.feishu.replyMarkdown(source, "ℹ️ 当前没有正在处理的任务。");
      }
      return;
    }

    if (cmd === "/help") {
      await this.feishu.replyMarkdown(source,
        "🤖 **飞书桥接使用帮助**\n\n" +
        "直接发送消息即可与 pi 编码助手对话。\n\n" +
        "**命令:**\n" +
        "  `/new`  — 重建会话，清空上下文\n" +
        "  `/stop` — 中止当前处理\n" +
        "  `/help` — 显示此帮助\n\n" +
        "**提示:**\n" +
        "  - 上下文满时会报错，发送 `/new` 即可重置\n" +
        "  - 群聊中需要 @机器人 才会响应\n" +
        "  - 私聊直接发消息即可"
      );
      return;
    }

    // ─── 处理普通消息 ──────────────────────────────────────
    const session = await this.sessionManager.getOrCreate(sessionKey, source.chatId);

    // 先发 "正在思考"
    await this.feishu.replyMarkdown(source, "🤔 **正在思考...**");

    // 启动 Markdown 流
    let streamController = await this.feishu.streamMarkdown(source.chatId);
    let hasOutput = false;

    // 发送 prompt 并处理流式输出
    await this.sessionManager.prompt(session, text, {
      onDelta: async (delta: string) => {
        if (!hasOutput) {
          await streamController.setContent("");
          hasOutput = true;
        }
        await streamController.append(delta);
      },
      onDone: async () => {
        if (!hasOutput) {
          await streamController.setContent("✅ **处理完成。**");
        }
        console.log(`[完成] 回复完成`);
      },
      onError: async (err: string) => {
        console.error(`[错误] ${err}`);
        if (!hasOutput) {
          await streamController.setContent(err);
        } else {
          await streamController.append(`\n\n---\n${err}`);
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
