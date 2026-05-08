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

  // ─── 飞书表情反应（Emoji Reaction） ───────────────────

  /** 状态表情映射，逐个尝试直到成功 */
  private async tryReactions(messageId: string, types: string[]): Promise<boolean> {
    for (const t of types) {
      try {
        await this.channel.addReaction(messageId, t);
        console.log(`[reaction] ${t} OK`);
        return true;
      } catch {
        console.log(`[reaction] ${t} 不支持`);
      }
    }
    return false;
  }

  /** 移除已添加的表情 */
  private async removeReactions(messageId: string, types: string[]): Promise<void> {
    for (const t of types) {
      try { await this.channel.removeReactionByEmoji(messageId, t); } catch {}
    }
  }

  // 基于飞书官方文档的 emoji_type 映射
  // 来源: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emoji-list
  private processingEmoji = "OneSecond";   // ⏳ 等待中
  private toolEmoji = "Fire";              // 🔥 执行中
  private doneEmoji = "CLAP";              // 👏 完成
  private errorEmoji = "CRY";              // 😢 错误

  /** 标记处理中 ⏳ */
  async reactProcessing(messageId: string): Promise<void> {
    try { await this.channel.addReaction(messageId, this.processingEmoji); } catch {}
  }

  /** 标记正在执行命令 🔥 */
  async reactToolRunning(messageId: string): Promise<void> {
    await this.removeReactions(messageId, [this.processingEmoji]);
    try { await this.channel.addReaction(messageId, this.toolEmoji); } catch {}
  }

  /** 标记完成 👏 */
  async reactDone(messageId: string): Promise<void> {
    await this.removeReactions(messageId, [this.processingEmoji, this.toolEmoji]);
    try { await this.channel.addReaction(messageId, this.doneEmoji); } catch {}
  }

  /** 标记错误 😢 */
  async reactError(messageId: string): Promise<void> {
    await this.removeReactions(messageId, [this.processingEmoji, this.toolEmoji]);
    try { await this.channel.addReaction(messageId, this.errorEmoji); } catch {}
  }

  // ─── 文本回复（状态标记） ───────────────────────────────

  /** 回复处理中提示 */
  async replyProcessing(source: FeishuSource): Promise<void> {
    try {
      await this.channel.send(source.chatId, { text: "👀" }, { replyTo: source.messageId });
      console.log(`[飞书] 👀 已发送`);
    } catch (err) {
      console.error(`[飞书] 👀 发送失败:`, err);
    }
  }

  /** 回复完成标记 */
  async replyDone(source: FeishuSource): Promise<void> {
    try { await this.channel.send(source.chatId, { text: "✅ 完成" }, { replyTo: source.messageId }); } catch { /* ignore */ }
  }

  /** 回复错误标记 */
  async replyError(source: FeishuSource, errMsg: string): Promise<void> {
    try { await this.channel.send(source.chatId, { text: `❌ ${errMsg}` }, { replyTo: source.messageId }); } catch { /* ignore */ }
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
