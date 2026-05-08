/**
 * 配置管理
 *
 * 简化版：工作目录固定为 process.cwd()，与 pi 一致。
 * 不需要 workspaces_dir、cwd 等隔离配置。
 */

import { readConfig, mergeWithEnv } from "./config-store.js";

export interface BridgeConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  port: number;
  /** 会话存储目录，为空时使用 pi 默认 ~/.pi/agent/sessions/ */
  sessionsDir: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  timeout: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(): BridgeConfig {
  const file = readConfig();
  const env = mergeWithEnv(file);

  return {
    feishuAppId:     env.feishuAppId,
    feishuAppSecret: env.feishuAppSecret,
    port:            Number(env.port),
    sessionsDir:     env.sessionsDir,
    model:           env.model,
    thinkingLevel:   env.thinkingLevel as BridgeConfig["thinkingLevel"],
    timeout:         Number(env.timeout),
    logLevel:        env.logLevel as BridgeConfig["logLevel"],
  };
}
