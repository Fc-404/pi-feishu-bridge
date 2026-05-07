#!/usr/bin/env node

/**
 * pi-feishu-bridge CLI 入口
 *
 * 使用方式:
 *   pi-feishu                         # 前台运行
 *   pi-feishu --daemon                # 后台守护进程
 *   pi-feishu --export-env            # 从配置文件生成 systemd 环境文件
 *   pi-feishu --log-dir ./logs        # 指定日志目录（配合 --daemon）
 */

import { loadConfig } from "../config.js";
import { BridgeServer } from "../server.js";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

// 解析命令行参数
const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[key] = args[++i];
    } else {
      flags[key] = "true";
    }
  }
}

if (flags["help"] || flags["h"]) {
  console.log(`
pi-feishu-bridge — 飞书 ↔ pi 编码助手实时对话桥接服务

使用方式:
  pi-feishu                         前台运行
  pi-feishu --daemon                后台守护进程模式
  pi-feishu --export-env            生成 systemd 环境文件
  pi-feishu --log-dir ./logs        指定日志目录 (配合 --daemon)

环境变量:
  FEISHU_APP_ID             飞书 App ID (必填)
  FEISHU_APP_SECRET         飞书 App Secret (必填)
  PORT                      健康检查端口 (默认: 3700)
  PI_FEISHU_WORKSPACES      工作目录 (默认: ./workspaces)
  PI_FEISHU_SESSIONS        会话存储目录 (默认: ./sessions)
  PI_FEISHU_MODEL           模型 (默认: google/gemini-2.5-flash-preview-05-06)
  PI_FEISHU_THINKING        thinking 等级 (默认: off)
  PI_FEISHU_TIMEOUT         超时毫秒 (默认: 300000)
  PI_FEISHU_LOG_LEVEL       日志等级 (默认: info)

示例:
  FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx pi-feishu
  pi-feishu --daemon
  pi-feishu --export-env              # 生成 ~/.pi/agent/feishu-config.env
`);
  process.exit(0);
}

// ─── --export-env: 生成 systemd 环境文件 ─────────────────────
if (flags["export-env"]) {
  const { readConfig, mergeWithEnv } = await import("../config-store.js");
  const file = readConfig();
  const merged = mergeWithEnv(file);

  const envPath = resolve(process.env.HOME || "~", ".pi/agent/feishu-config.env");
  mkdirSync(resolve(process.env.HOME || "~", ".pi/agent"), { recursive: true });

  const lines = [
    `FEISHU_APP_ID=${merged.feishuAppId}`,
    `FEISHU_APP_SECRET=${merged.feishuAppSecret}`,
    `PORT=${merged.port}`,
    `PI_FEISHU_MODEL=${merged.model}`,
    `PI_FEISHU_THINKING=${merged.thinkingLevel}`,
    `PI_FEISHU_TIMEOUT=${merged.timeout}`,
    `PI_FEISHU_LOG_LEVEL=${merged.logLevel}`,
    `PI_FEISHU_WORKSPACES=${merged.workspacesDir}`,
    `PI_FEISHU_SESSIONS=${merged.sessionsDir}`,
  ];

  writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
  console.log(`✅ 环境文件已生成: ${envPath}`);
  console.log("现在可以启动 systemd 服务:");
  console.log(`  systemctl --user daemon-reload`);
  console.log(`  systemctl --user start pi-feishu-bridge`);
  process.exit(0);
}

// ─── --daemon: 后台守护进程 ──────────────────────────────────
if (flags["daemon"]) {
  const logDir = resolve(flags["log-dir"] || "./logs");
  mkdirSync(logDir, { recursive: true });

  const pidPath = resolve(logDir, "pi-feishu-bridge.pid");
  const outPath = resolve(logDir, "output.log");
  const errPath = resolve(logDir, "error.log");

  // 检查是否已在运行
  if (existsSync(pidPath)) {
    try {
      const oldPid = Number(await import("node:fs").then(m => m.readFileSync(pidPath, "utf-8")));
      try {
        process.kill(oldPid, 0); // 检查进程是否存在
        console.log(`❌ 桥接服务已在运行 (PID: ${oldPid})`);
        console.log(`   日志: ${outPath}`);
        process.exit(1);
      } catch { /* 进程已死，继续启动 */ }
    } catch { /* 忽略 */ }
  }

  // 创建子进程
  const childArgs = process.argv.filter(a => a !== "--daemon" && !a.startsWith("--log-dir"));
  // 去掉 --daemon 和 --log-dir 参数，保留其他参数
  const filteredArgs = [];
  for (let i = 1; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--daemon") continue;
    if (a === "--log-dir") { i++; continue; }
    filteredArgs.push(a);
  }

  const out = await import("node:fs").then(m => m.openSync(outPath, "a"));
  const err = await import("node:fs").then(m => m.openSync(errPath, "a"));

  const child = spawn(process.argv[0], filteredArgs, {
    stdio: ["ignore", out, err],
    detached: true,
  });

  // 写 PID 文件
  writeFileSync(pidPath, String(child.pid), "utf-8");

  console.log(`✅ 桥接服务已后台启动 (PID: ${child.pid})`);
  console.log(`   日志: ${outPath}`);
  console.log(`   错误: ${errPath}`);

  child.unref();
  process.exit(0);
}

// ─── 前台运行 ────────────────────────────────────────────────
const config = loadConfig();
const server = new BridgeServer(config);

server.start().catch((err) => {
  console.error("❌ 启动失败:", err);
  process.exit(1);
});
