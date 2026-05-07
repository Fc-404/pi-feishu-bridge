/**
 * 桥接服务主逻辑
 * 连接飞书 WebSocket ↔ pi AgentSession
 *
 * 飞书消息支持的命令:
 *   /new      - 重建会话（清空上下文）
 *   /stop     - 中止当前处理（不丢失上下文）
 *   /compact  - 压缩上下文（节省 token）
 *   /help     - 查看帮助
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
    console.log("   给飞书机器人发消息即可开始对话！");
    console.log("   命令: /new(重建)  /stop(中止)  /compact(压缩)  /help(帮助)");
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

    // ─── /new ──────────────────────────────────────────────
    if (cmd === "/new") {
      const r = await this.sessionManager.resetSession(sessionKey);
      await this.feishu.replyMarkdown(source,
        r.success ? "✅ 会话已重置，上下文已清空。" : `❌ 重置失败: ${r.error}`
      );
      return;
    }

    // ─── /stop ─────────────────────────────────────────────
    if (cmd === "/stop") {
      const aborted = this.sessionManager.abortProcessing(sessionKey);
      await this.feishu.replyMarkdown(source,
        aborted ? "⏹ 已中止，上下文未丢失。" : "ℹ️ 当前没有正在处理的任务。"
      );
      return;
    }

    // ─── /compact ──────────────────────────────────────────
    if (cmd === "/compact") {
      await this.sessionManager.getOrCreate(sessionKey, source.chatId);
      await this.feishu.replyMarkdown(source, "🗜️ 正在压缩上下文...");
      const r = await this.sessionManager.compactSession(sessionKey);
      await this.feishu.replyMarkdown(source,
        r.success ? "✅ 上下文已压缩，可继续对话。" : `❌ 压缩失败: ${r.error}`
      );
      return;
    }

    // ─── /help ─────────────────────────────────────────────
    if (cmd === "/help") {
      const p = readPromptFile();
      const m = readMemoryFile();
      await this.feishu.replyMarkdown(source,
        "**飞书桥接使用帮助**\n\n" +
        "直接发送消息即可与 pi 编码助手对话。\n\n" +
        "**命令:**\n" +
        "  /new     重建会话，清空上下文\n" +
        "  /stop    中止当前处理（上下文保留）\n" +
        "  /compact 压缩上下文，释放 token\n" +
        "  /help    显示此帮助\n\n" +
        "**提示词:** " + (p ? `✅ 已加载 (${p.length} 字符)` : "❌ 未设置") + "\n" +
        "**记忆文件:** " + (m ? `✅ 已加载 (${m.length} 字符)` : "❌ 未设置") + "\n\n" +
        "提示: 上下文满时可发 /compact 或 /new\n群聊中需 @机器人 才会响应"
      );
      return;
    }

    // ─── 普通消息 ──────────────────────────────────────────
    const session = await this.sessionManager.getOrCreate(sessionKey, source.chatId);
    const enrichedText = this.sessionManager.buildMessage(text);

    // 流式回复（自动以"正在思考"开头，收到真实内容后替换）
    const stream = await this.feishu.streamMarkdown(source);
    let hasOutput = false;

    await this.sessionManager.prompt(session, enrichedText, {
      onDelta: async (delta: string) => {
        if (!hasOutput) {
          await stream.setContent(delta);
          hasOutput = true;
        } else {
          await stream.append(delta);
        }
      },
      onDone: async () => {
        if (!hasOutput) {
          await stream.setContent("✅ 处理完成。");
        }
        console.log(`[完成] 回复完成`);
      },
      onError: async (err: string) => {
        console.error(`[错误] ${err}`);
        if (!hasOutput) {
          await stream.setContent(err);
        } else {
          await stream.append(`\n\n---\n${err}`);
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
