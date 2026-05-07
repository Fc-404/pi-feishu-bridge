/**
 * 飞书 WebSocket 事件订阅客户端
 * 使用 @larksuiteoapi/node-sdk 的 LarkChannel 连接飞书事件推送
 */

import { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { BridgeConfig } from "./config.js";
import type { FeishuSource } from "./types.js";

/** 飞书消息回调 */
export interface FeishuMessageHandler {
  (source: FeishuSource, text: string): Promise<void>;
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
      policy: { requireMention: true },
    });

    this.channel.on("message", async (msg: NormalizedMessage) => {
      try {
        const text = msg.content?.trim();
        if (!text) return;

        const cleanText = this.stripBotMention(text, msg.mentions);
        if (!cleanText) return;

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

    this.channel.on("reconnecting", () => console.log("[飞书] WebSocket 正在重连..."));
    this.channel.on("reconnected", () => console.log("[飞书] WebSocket 重连成功"));
    this.channel.on("error", (err) => console.error("[飞书] 连接错误:", err.message));

    await this.channel.connect();
    console.log("[飞书] WebSocket 事件订阅已连接");
  }

  // ─── 表情反应 (Reaction) 状态标记 ─────────────────────

  /** 标记"正在处理" 👀 */
  async markProcessing(messageId: string): Promise<void> {
    try { await this.channel.addReaction(messageId, "eyes"); } catch { /* ignore */ }
  }

  /** 标记"完成" ✅，并清除处理标记 */
  async markDone(messageId: string): Promise<void> {
    try { await this.channel.removeReactionByEmoji(messageId, "eyes"); } catch { /* ignore */ }
    try { await this.channel.addReaction(messageId, "white_check_mark"); } catch { /* ignore */ }
  }

  /** 标记"错误" ❌，并清除处理标记 */
  async markError(messageId: string): Promise<void> {
    try { await this.channel.removeReactionByEmoji(messageId, "eyes"); } catch { /* ignore */ }
    try { await this.channel.addReaction(messageId, "x"); } catch { /* ignore */ }
  }

  // ─── 文本回复（仅 `/new` `/help` 等命令使用） ─────────

  /** 回复文本消息（关联到原消息） */
  async replyText(source: FeishuSource, text: string): Promise<string | undefined> {
    try {
      const r = await this.channel.send(source.chatId, { text }, { replyTo: source.messageId });
      return r.messageId;
    } catch (err) {
      console.error("[飞书] 发送文本失败:", err);
      return undefined;
    }
  }

  /** 回复 Markdown 消息（关联到原消息） */
  async replyMarkdown(source: FeishuSource, markdown: string): Promise<string | undefined> {
    try {
      const r = await this.channel.send(source.chatId, { markdown }, { replyTo: source.messageId });
      return r.messageId;
    } catch (err) {
      console.error("[飞书] 发送 Markdown 失败:", err);
      return undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.channel) {
      try { await this.channel.disconnect(); } catch { /* ignore */ }
    }
    console.log("[飞书] 桥接服务已断开");
  }

  private stripBotMention(text: string, mentions: NormalizedMessage["mentions"]): string {
    if (!mentions?.length) return text;
    for (const m of mentions) {
      if (m.isBot && m.name) text = text.replace(`@${m.name}`, "").trim();
    }
    return text.trim();
  }
}
