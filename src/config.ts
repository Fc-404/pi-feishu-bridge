/**
 * 配置管理
 * 优先级: 环境变量 > 配置文件 > 默认值
 */

import { readConfig, mergeWithEnv } from "./config-store.js";

export interface BridgeConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  port: number;
  /** 用户隔离的沙箱目录 */
  workspacesDir: string;
  sessionsDir: string;
  /** 实际工作目录，工具在此路径下操作文件 */
  cwd: string;
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
    cwd:             env.cwd,
    model:           env.model,
    thinkingLevel:   env.thinkingLevel as BridgeConfig["thinkingLevel"],
    timeout:         Number(env.timeout),
    logLevel:        env.logLevel as BridgeConfig["logLevel"],
  };
}
