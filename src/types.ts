/**
 * 桥接服务的共享类型
 */

/** 飞书消息来源标识 */
export interface FeishuSource {
  /** 消息 ID */
  messageId: string;
  /** 发送者 ID (open_id / user_id) */
  senderId: string;
  /** 发送者名称 */
  senderName: string;
  /** 聊天 ID (单聊或群聊) */
  chatId: string;
  /** 聊天类型 */
  chatType: "p2p" | "group";
}

/** 回复消息体 */
export interface ReplyMessage {
  text: string;
  msgType: "text" | "interactive";
  /** 可选的消息 ID，用于流式更新 */
  updateMessageId?: string;
}

/** pi 会话上下文 */
export interface PiContext {
  /** 唯一标识，用于恢复 session */
  sessionKey: string;
  /** 飞书来源 */
  source: FeishuSource;
  /** 工作目录 */
  cwd: string;
}
