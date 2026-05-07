/**
 * 桥接服务主逻辑
 * 连接飞书 WebSocket ↔ pi AgentSession
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

    setInterval(() => this.sessionManager.cleanIdle(), 15 * 60 * 1000);
    this.registerShutdown();

    console.log("\n✅ 飞书 ↔ pi 桥接服务已启动");
    console.log(`   模型: ${config.model}`);
    console.log(`   超时: ${config.timeout / 1000}s`);
    console.log(`   会话目录: ${config.sessionsDir}`);
    console.log(`   工作目录: ${config.workspacesDir}`);
    console.log("");
    console.log("   给飞书机器人发消息即可开始对话！");
  }

  private async handleMessage(source: FeishuSource, text: string) {
    console.log(
      `[消息] ${source.chatType === "p2p" ? "私聊" : "群聊"} ` +
      `来自 ${source.senderName}: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`
    );

    const sessionKey = source.chatType === "group"
      ? `group_${source.chatId}`
      : `user_${source.senderId}`;

    // 获取/创建 pi session
    const session = await this.sessionManager.getOrCreate(sessionKey, source.chatId);

    // 1. 先发一条 "正在思考"
    await this.feishu.replyMarkdown(source, "🤔 **正在思考...**");

    // 2. 启动 Markdown 流，用于实时输出
    let streamController = await this.feishu.streamMarkdown(source.chatId);
    let hasOutput = false;

    // 3. 发送 prompt 并处理流式输出
    await this.sessionManager.prompt(session, text, {
      onDelta: async (delta: string) => {
        if (!hasOutput) {
          // 第一次收到输出：覆盖 "正在思考"，开始输出内容
          await streamController.setContent("");
          hasOutput = true;
        }
        await streamController.append(delta);
      },
      onDone: async () => {
        if (!hasOutput) {
          // 没有流式输出的情况（可能直接返回了工具调用结果）
          // 更新 "正在思考" 为完成状态
          await streamController.setContent("✅ **处理完成。**");
        }
        console.log(`[完成] 回复完成`);
      },
      onError: async (err: string) => {
        console.error(`[错误] ${err}`);
        if (!hasOutput) {
          await streamController.setContent(`❌ **出错了**: ${err}`);
        } else {
          await streamController.append(`\n\n---\n❌ **出错了**: ${err}`);
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
