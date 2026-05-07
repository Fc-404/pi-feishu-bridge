/**
 * 飞书 WebSocket 事件订阅客户端
 * 使用 @larksuiteoapi/node-sdk 的 LarkChannel 连接飞书事件推送
 */

import { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { MarkdownStreamController, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { BridgeConfig } from "./config.js";
import type { FeishuSource } from "./types.js";

/** 飞书消息回调 */
export interface FeishuMessageHandler {
  (source: FeishuSource, text: string): Promise<void>;
}

/** 流式回复控制器 */
export interface StreamReplyController {
  append(text: string): Promise<void>;
  setContent(full: string): Promise<void>;
  messageId: string;
}

export class FeishuClient {
  private channel!: LarkChannel;
  private handler?: FeishuMessageHandler;
  private started = false;

  constructor(private config: BridgeConfig) {}

  onMessage(handler: FeishuMessageHandler) {
    this.handler = handler;
  }

  /** 启动 WebSocket 事件订阅 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (!this.handler) {
      throw new Error("请先调用 onMessage() 注册消息处理器");
    }

    console.log("[飞书] 正在连接 WebSocket 事件订阅...");

    this.channel = new LarkChannel({
      appId: this.config.feishuAppId,
      appSecret: this.config.feishuAppSecret,
      loggerLevel: this.config.logLevel === "debug" ? 0 : 1,
      policy: {
        requireMention: true,
      },
    });

    this.channel.on("message", async (msg: NormalizedMessage) => {
      try {
        const text = msg.content?.trim();
        if (!text) return;

        const cleanText = this.stripBotMention(text, msg.mentions);

        const source: FeishuSource = {
          messageId: msg.messageId,
          senderId: msg.senderId,
          senderName: msg.senderName ?? "Unknown",
          chatId: msg.chatId,
          chatType: msg.chatType as "p2p" | "group",
        };

        await this.handler!(source, cleanText);
      } catch (err) {
        console.error("[飞书] 处理消息出错:", err);
      }
    });

    this.channel.on("reconnecting", () => {
      console.log("[飞书] WebSocket 正在重连...");
    });

    this.channel.on("reconnected", () => {
      console.log("[飞书] WebSocket 重连成功");
    });

    this.channel.on("error", (err) => {
      console.error("[飞书] 连接错误:", err.message);
    });

    await this.channel.connect();
    console.log("[飞书] WebSocket 事件订阅已连接");
  }

  /** 快速回复文本消息 */
  async replyText(
    source: FeishuSource,
    text: string,
  ): Promise<string | undefined> {
    try {
      const result = await this.channel.send(source.chatId, { text });
      return result.messageId;
    } catch (err) {
      console.error("[飞书] 发送消息失败:", err);
      return undefined;
    }
  }

  /** 回复 Markdown 消息 */
  async replyMarkdown(
    source: FeishuSource,
    markdown: string,
  ): Promise<string | undefined> {
    try {
      const result = await this.channel.send(source.chatId, { markdown });
      return result.messageId;
    } catch (err) {
      console.error("[飞书] 发送 Markdown 失败:", err);
      return undefined;
    }
  }

  /**
   * 启动 Markdown 流式回复
   * 返回控制器，可在后续持续追加内容
   */
  async streamMarkdown(
    chatId: string,
  ): Promise<StreamReplyController> {
    let externalController: StreamReplyController | null = null;

    // stream 方法内部的 producer 会在连接建立后立即调用
    // 但我们需要在外部的 await 之后拿到 controller
    const streamPromise = this.channel.stream(chatId, {
      markdown: async (ctrl: MarkdownStreamController) => {
        externalController = {
          append: (text: string) => ctrl.append(text),
          setContent: (full: string) => ctrl.setContent(full),
          messageId: ctrl.messageId,
        };
      },
    });

    // 等待 controller 就绪
    while (!externalController) {
      await new Promise((r) => setImmediate(r));
    }

    return externalController;
  }

  /** 发送交互卡片 */
  async sendCard(
    chatId: string,
    card: object,
  ): Promise<string | undefined> {
    try {
      const result = await this.channel.send(chatId, { card });
      return result.messageId;
    } catch (err) {
      console.error("[飞书] 发送卡片失败:", err);
      return undefined;
    }
  }

  /** 停止连接 */
  async stop(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.disconnect();
      } catch {
        // ignore
      }
    }
    console.log("[飞书] 桥接服务已断开");
  }

  /** 去掉消息中的 @bot 标签 */
  private stripBotMention(text: string, mentions: NormalizedMessage["mentions"]): string {
    if (!mentions?.length) return text;
    for (const mention of mentions) {
      if (mention.isBot && mention.name) {
        text = text.replace(`@${mention.name}`, "").trim();
      }
    }
    return text.trim();
  }
}
