/**
 * 配置管理
 * 优先级: 环境变量 > 配置文件 > 默认值
 */

import { readConfig, mergeWithEnv } from "./config-store.js";

export interface BridgeConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  port: number;
  workspacesDir: string;
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
    workspacesDir:   env.workspacesDir,
    sessionsDir:     env.sessionsDir,
    model:           env.model,
    thinkingLevel:   env.thinkingLevel as BridgeConfig["thinkingLevel"],
    timeout:         Number(env.timeout),
    logLevel:        env.logLevel as BridgeConfig["logLevel"],
  };
}
