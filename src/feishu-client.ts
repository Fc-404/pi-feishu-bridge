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
      safety: { chatQueue: { enabled: false } },
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

  // ─── 链式表情反应 ──────────────────────────────────────
  // Get                  → 用户消息（已收到）
  // StatusFlashOfInspiration → bot 回复（LLM 思考）
  // Typing               → bot 回复（执行命令）
  // DONE                 → bot 最终回复（完成）
  // ClownFace            → bot 回复（错误）

  /** 给指定消息加表情 */
  async addReaction(msgId: string, emoji: string): Promise<void> {
    try { await this.channel.addReaction(msgId, emoji); } catch {}
  }

  /** 给用户消息加 Get（已收到） */
  async reactGet(source: FeishuSource): Promise<void> {
    await this.addReaction(source.messageId, "Get");
  }

  /** 发送文本回复并在其上挂表情，返回消息 ID */
  async replyWithReaction(source: FeishuSource, text: string, emoji: string): Promise<string | undefined> {
    const msgId = await this.replyMarkdown(source, text);
    if (msgId) await this.addReaction(msgId, emoji);
    return msgId;
  }

  /** 给指定回复消息加 DONE 完成表情 */
  async reactDone(replyMsgId: string): Promise<void> {
    await this.addReaction(replyMsgId, "DONE");
  }

  /** 给指定回复消息加 ClownFace 错误表情 */
  async reactError(replyMsgId: string): Promise<void> {
    await this.addReaction(replyMsgId, "ClownFace");
  }

  // ─── 文本回复 ──────────────────────────────────────────

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
      console.log(`[飞书] Markdown 回复成功: messageId=${r.messageId?.slice(0, 20)}...`);
      return r.messageId;
    } catch (err) {
      console.log(`[飞书] ❌ Markdown 发送失败:`, err);
      console.log(`[飞书] 尝试纯文本回复作为降级...`);
      try {
        const r = await this.channel.send(source.chatId, { text: markdown.slice(0, 2000) }, { replyTo: source.messageId });
        console.log(`[飞书] 纯文本降级成功`);
        return r.messageId;
      } catch (textErr) {
        console.log(`[飞书] ❌ 纯文本降级也失败:`, textErr);
        return undefined;
      }
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
