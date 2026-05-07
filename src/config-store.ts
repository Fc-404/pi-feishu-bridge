/**
 * 配置文件读写
 * 全局: ~/.pi/agent/feishu-config.json
 * 项目: .pi/feishu-config.json (覆盖全局)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 配置文件中的键值 */
export interface ConfigFile {
  feishu_app_id?: string;
  feishu_app_secret?: string;
  model?: string;
  thinking_level?: string;
  port?: number;
  timeout?: number;
  log_level?: string;
  workspaces_dir?: string;
  sessions_dir?: string;
  cwd?: string;
}

/** 配置键的描述和类型 */
export const CONFIG_KEYS: Record<string, { description: string; type: "string" | "number" | "enum"; enum?: string[]; secret?: boolean }> = {
  feishu_app_id:     { description: "飞书 App ID", type: "string" },
  feishu_app_secret: { description: "飞书 App Secret", type: "string", secret: true },
  model:             { description: "模型 (provider/id 格式)", type: "string" },
  thinking_level:    { description: "Thinking 等级", type: "enum", enum: ["off", "minimal", "low", "medium", "high", "xhigh"] },
  port:              { description: "健康检查端口", type: "number" },
  timeout:           { description: "超时毫秒", type: "number" },
  log_level:         { description: "日志等级", type: "enum", enum: ["debug", "info", "warn", "error"] },
  workspaces_dir:    { description: "工作目录", type: "string" },
  sessions_dir:      { description: "会话存储目录", type: "string" },
  cwd:               { description: "工作目录（文件操作路径）", type: "string" },
};

/** 获取配置文件路径 */
function getConfigPaths(): { global: string; project: string } {
  const globalDir = join(homedir(), ".pi", "agent");
  const projectDir = resolve(".pi");
  return {
    global: join(globalDir, "feishu-config.json"),
    project: join(projectDir, "feishu-config.json"),
  };
}

/** 读取配置文件（全局 + 项目合并，项目优先） */
export function readConfig(): ConfigFile {
  const paths = getConfigPaths();
  const global = readJson(paths.global);
  const project = readJson(paths.project);
  return { ...global, ...project };
}

/** 写入项目级配置 */
export function writeConfig(updates: Partial<ConfigFile>): ConfigFile {
  const paths = getConfigPaths();
  const current = readJson(paths.project);
  const merged = { ...current, ...updates };

  // 移除 undefined 值
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) delete (merged as any)[k];
  }

  mkdirSync(resolve(".pi"), { recursive: true });
  writeFileSync(paths.project, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

/** 设置单个配置项 */
export function setConfig(key: string, value: string): { success: boolean; error?: string } {
  const meta = CONFIG_KEYS[key];
  if (!meta) {
    return { success: false, error: `未知配置项: ${key}。可用项: ${Object.keys(CONFIG_KEYS).join(", ")}` };
  }

  // 类型校验
  if (meta.type === "number") {
    const num = Number(value);
    if (isNaN(num)) return { success: false, error: `${key} 应为数字` };
    writeConfig({ [key]: num });
  } else if (meta.type === "enum") {
    if (meta.enum && !meta.enum.includes(value)) {
      return { success: false, error: `${key} 可选值: ${meta.enum.join(", ")}` };
    }
    writeConfig({ [key]: value });
  } else {
    writeConfig({ [key]: value });
  }

  return { success: true };
}

/** 读取 JSON 文件，不存在返回空对象 */
function readJson(path: string): Record<string, unknown> {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // 忽略解析错误
  }
  return {};
}

/** 合并配置文件 + 环境变量（环境变量优先） */
export function mergeWithEnv(file: ConfigFile): Record<string, string> {
  return {
    feishuAppId:     process.env.FEISHU_APP_ID ?? file.feishu_app_id ?? "",
    feishuAppSecret: process.env.FEISHU_APP_SECRET ?? file.feishu_app_secret ?? "",
    model:           process.env.PI_FEISHU_MODEL ?? file.model ?? "google/gemini-2.5-flash-preview-05-06",
    thinkingLevel:   process.env.PI_FEISHU_THINKING ?? file.thinking_level ?? "off",
    port:            process.env.PORT ?? String(file.port ?? "3700"),
    timeout:         process.env.PI_FEISHU_TIMEOUT ?? String(file.timeout ?? "300000"),
    logLevel:        process.env.PI_FEISHU_LOG_LEVEL ?? file.log_level ?? "info",
    workspacesDir:   process.env.PI_FEISHU_WORKSPACES ?? file.workspaces_dir ?? "./workspaces",
    sessionsDir:     process.env.PI_FEISHU_SESSIONS ?? file.sessions_dir ?? "./sessions",
    cwd:             process.env.PI_FEISHU_CWD ?? file.cwd ?? process.cwd(),
  };
}
