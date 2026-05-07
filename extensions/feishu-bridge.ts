/**
 * pi-feishu-bridge Pi 扩展
 *
 * 命令:
 *   /feishu-status      查看状态（进程 + systemd）
 *   /feishu-start       启动桥接服务（前台进程）
 *   /feishu-stop        停止桥接服务
 *   /feishu-daemon      后台守护进程模式启动 (--daemon)
 *   /feishu-install     安装 systemd 用户服务（开机自启）
 *   /feishu-uninstall   卸载 systemd 服务
 *   /feishu-logs        查看最近日志
 *   /feishu-config      查看完整配置
 *   /feishu-set <k> <v> 设置配置项
 *
 * 安装:
 *   pi install ./pi-feishu-bridge
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface AutocompleteItem {
  value: string;
  label: string;
}

export default function (pi: ExtensionAPI) {
  let childProcess: any = null;

  async function getStore() {
    return await import(/* @vite-ignore */ "../src/config-store.js");
  }

  /** 检查 systemd 服务状态 */
  async function systemdStatus(): Promise<{ installed: boolean; running: boolean; pid?: string; uptime?: string }> {
    try {
      const { execSync } = await import("node:child_process");
      execSync("systemctl --user --version", { stdio: "ignore" });
    } catch {
      return { installed: false, running: false };
    }

    try {
      const { execSync } = await import("node:child_process");
      const isActive = execSync(
        "systemctl --user is-active pi-feishu-bridge.service",
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim() === "active";

      let pid: string | undefined;
      let uptime: string | undefined;
      if (isActive) {
        pid = execSync(
          "systemctl --user show -p MainPID pi-feishu-bridge.service",
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim().replace("MainPID=", "");
        if (pid === "0") pid = undefined;

        const activeEnter = execSync(
          "systemctl --user show -p ActiveEnterTimestamp pi-feishu-bridge.service",
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim().replace("ActiveEnterTimestamp=", "");
        uptime = activeEnter || undefined;
      }

      return { installed: true, running: isActive, pid, uptime };
    } catch {
      const { existsSync, readFileSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const svcPath = `${homedir()}/.config/systemd/user/pi-feishu-bridge.service`;
      return { installed: existsSync(svcPath), running: false };
    }
  }

  /** 检查 daemon 进程 */
  function daemonStatus(): { running: boolean; pid?: number } {
    try {
      const { existsSync, readFileSync } = require("node:fs");
      const { resolve } = require("node:path");
      const pidPath = resolve(".pi/feishu-bridge.pid");
      if (!existsSync(pidPath)) return { running: false };

      const pid = Number(readFileSync(pidPath, "utf-8").trim());
      if (isNaN(pid)) return { running: false };

      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      return { running: false };
    }
  }

  // ─── /feishu-status ──────────────────────────────────────
  pi.registerCommand("feishu-status", {
    description: "查看桥接服务运行状态（前台/daemon/systemd）",
    handler: async (_args, ctx) => {
      const store = await getStore();
      const file = store.readConfig();
      const env = store.mergeWithEnv(file);

      const frontend = childProcess !== null && !childProcess.killed;
      const daemon = daemonStatus();
      const sd = await systemdStatus();

      const lines = [
        "📊 **桥接服务状态**",
        "",
        "**前台进程** (pi TUI 内 /feishu-start):",
        `  ${frontend ? "🟢 运行中" : "🔴 未启动"}`,
        "",
        "**后台 daemon** (pi-feishu --daemon):",
        `  ${daemon.running ? `🟢 运行中 (PID: ${daemon.pid})` : "🔴 未启动"}`,
        "",
        "**systemd 服务** (开机自启):",
        `  已安装: ${sd.installed ? "✅" : "❌"}`,
        `  运行中: ${sd.running ? "🟢" : "🔴"}${sd.pid ? ` (PID: ${sd.pid})` : ""}`,
        "",
        "**配置:**",
        `  App ID: ${hide(env.feishuAppId)}`,
        `  Secret: ${env.feishuAppSecret ? "✅ 已配置" : "❌ 未配置"}`,
        `  模型: ${env.model}`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── /feishu-start（前台） ────────────────────────────────
  pi.registerCommand("feishu-start", {
    description: "在前台启动桥接服务（依附于当前 pi 进程）",
    handler: async (_args, ctx) => {
      if (childProcess && !childProcess.killed) {
        ctx.ui.notify("⚠️ 前台进程已在运行中\n使用 /feishu-daemon 或 systemd 运行", "warning");
        return;
      }

      const store = await getStore();
      const file = store.readConfig();
      const merged = store.mergeWithEnv(file);

      if (!merged.feishuAppId || !merged.feishuAppSecret) {
        ctx.ui.notify("❌ 请先配置: /feishu-set feishu_app_id <id>", "error");
        return;
      }

      try {
        const { spawn } = await import("node:child_process");
        const { fileURLToPath } = await import("node:url");
        const bridgePath = fileURLToPath(
          new URL("../dist/bin/start.js", import.meta.url),
        );

        const bridgeEnv: Record<string, string> = {
          ...process.env,
          FEISHU_APP_ID: merged.feishuAppId,
          FEISHU_APP_SECRET: merged.feishuAppSecret,
          PI_FEISHU_MODEL: merged.model,
          PI_FEISHU_THINKING: merged.thinkingLevel,
          PORT: merged.port,
          PI_FEISHU_TIMEOUT: merged.timeout,
          PI_FEISHU_LOG_LEVEL: merged.logLevel,
          PI_FEISHU_WORKSPACES: merged.workspacesDir,
          PI_FEISHU_SESSIONS: merged.sessionsDir,
        };

        childProcess = spawn("node", [bridgePath], {
          env: bridgeEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });

        childProcess.stdout.on("data", (data: Buffer) => {
          console.log(`[feishu-bridge] ${data.toString().trim()}`);
        });

        childProcess.stderr.on("data", (data: Buffer) => {
          console.error(`[feishu-bridge] ${data.toString().trim()}`);
        });

        childProcess.on("exit", (code: number | null) => {
          console.log(`[feishu-bridge] 前台进程退出 (code: ${code})`);
          childProcess = null;
        });

        ctx.ui.notify("✅ 前台桥接服务已启动", "info");
      } catch (err) {
        ctx.ui.notify(`❌ 启动失败: ${err}`, "error");
      }
    },
  });

  // ─── /feishu-daemon ──────────────────────────────────────
  pi.registerCommand("feishu-daemon", {
    description: "以后台守护进程模式启动（独立于 pi 进程，日志到文件）",
    handler: async (_args, ctx) => {
      const store = await getStore();
      const file = store.readConfig();
      const merged = store.mergeWithEnv(file);

      if (!merged.feishuAppId || !merged.feishuAppSecret) {
        ctx.ui.notify("❌ 请先配置: /feishu-set feishu_app_id <id>", "error");
        return;
      }

      try {
        const { spawn, execSync } = await import("node:child_process");
        const { fileURLToPath } = await import("node:url");
        const bridgePath = fileURLToPath(
          new URL("../dist/bin/start.js", import.meta.url),
        );
        const { resolve } = await import("node:path");
        const logDir = resolve(".pi/logs");

        const bridgeEnv: Record<string, string> = {
          ...process.env,
          FEISHU_APP_ID: merged.feishuAppId,
          FEISHU_APP_SECRET: merged.feishuAppSecret,
          PI_FEISHU_MODEL: merged.model,
          PI_FEISHU_THINKING: merged.thinkingLevel,
          PORT: merged.port,
          PI_FEISHU_TIMEOUT: merged.timeout,
          PI_FEISHU_LOG_LEVEL: merged.logLevel,
          PI_FEISHU_WORKSPACES: merged.workspacesDir,
          PI_FEISHU_SESSIONS: merged.sessionsDir,
        };

        const child = spawn("node", [bridgePath, "--daemon", "--log-dir", logDir], {
          env: bridgeEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });

        child.unref();

        // 等一会儿检查是否启动成功
        await new Promise((r) => setTimeout(r, 2000));

        ctx.ui.notify(
          "✅ 守护进程已启动！\n" +
          `日志: ${logDir}/output.log\n` +
          "查看: /feishu-logs\n" +
          "停止: 运行 pi-feishu --daemon 或 kill PID",
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`❌ 启动失败: ${err}`, "error");
      }
    },
  });

  // ─── /feishu-stop ────────────────────────────────────────
  pi.registerCommand("feishu-stop", {
    description: "停止所有桥接服务（前台 + daemon + 提示停 systemd）",
    handler: async (_args, ctx) => {
      const stopped: string[] = [];

      // 停前台进程
      if (childProcess && !childProcess.killed) {
        childProcess.kill("SIGTERM");
        childProcess = null;
        stopped.push("前台进程");
      }

      // 停 daemon 进程
      try {
        const { existsSync, readFileSync, unlinkSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const pidPath = resolve(".pi/feishu-bridge.pid");
        if (existsSync(pidPath)) {
          const pid = Number(readFileSync(pidPath, "utf-8").trim());
          if (!isNaN(pid)) {
            try {
              process.kill(pid, "SIGTERM");
              stopped.push(`daemon 进程 (PID: ${pid})`);
            } catch { /* 已死 */ }
          }
          unlinkSync(pidPath);
        }
      } catch { /* 忽略 */ }

      ctx.ui.notify(
        stopped.length > 0
          ? `⏹ 已停止: ${stopped.join(", ")}`
          : "ℹ️ 未检测到运行中的桥接服务\n如需停止 systemd 服务: systemctl --user stop pi-feishu-bridge",
        "info",
      );
    },
  });

  // ─── /feishu-install ─────────────────────────────────────
  pi.registerCommand("feishu-install", {
    description: "安装 systemd 用户服务（开机自启 + 自动重启）",
    handler: async (_args, ctx) => {
      try {
        const { execSync } = await import("node:child_process");
        const { fileURLToPath } = await import("node:url");
        const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
        const { homedir } = await import("node:os");
        const { resolve } = await import("node:path");

        // 读取服务模板
        const svcTemplatePath = fileURLToPath(
          new URL("../systemd/pi-feishu-bridge.service", import.meta.url),
        );
        let svcContent = readFileSync(svcTemplatePath, "utf-8");

        // 替换 ExecStart 为实际路径
        const binPath = fileURLToPath(
          new URL("../dist/bin/start.js", import.meta.url),
        );
        // systemd 服务使用 npx 方式
        svcContent = svcContent.replace(
          "ExecStart=%h/.npm-global/bin/pi-feishu",
          `ExecStart=${process.execPath} ${binPath}`,
        );

        // 写 systemd 用户服务
        const svcDir = `${homedir()}/.config/systemd/user`;
        mkdirSync(svcDir, { recursive: true });
        const svcPath = `${svcDir}/pi-feishu-bridge.service`;
        writeFileSync(svcPath, svcContent, "utf-8");

        // 生成环境文件
        const store = await getStore();
        const file = store.readConfig();
        const merged = store.mergeWithEnv(file);
        const envDir = `${homedir()}/.pi/agent`;
        mkdirSync(envDir, { recursive: true });
        const envPath = `${envDir}/feishu-config.env`;
        const envLines = [
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
        writeFileSync(envPath, envLines.join("\n") + "\n", "utf-8");

        // 重载 + 启用 + 启动
        execSync("systemctl --user daemon-reload", { stdio: "pipe" });
        execSync("systemctl --user enable pi-feishu-bridge.service", { stdio: "pipe" });
        execSync("systemctl --user restart pi-feishu-bridge.service", { stdio: "pipe" });

        ctx.ui.notify(
          "✅ systemd 服务已安装并启动！\n" +
          `服务文件: ${svcPath}\n` +
          `环境文件: ${envPath}\n` +
          "开机自启 ✅  崩溃重启 ✅\n" +
          "\n管理命令:\n" +
          "  systemctl --user status pi-feishu-bridge\n" +
          "  systemctl --user stop pi-feishu-bridge\n" +
          "  systemctl --user restart pi-feishu-bridge\n" +
          "  journalctl --user -u pi-feishu-bridge -f",
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`❌ 安装失败: ${err}\n请确保已安装 systemd`, "error");
      }
    },
  });

  // ─── /feishu-uninstall ───────────────────────────────────
  pi.registerCommand("feishu-uninstall", {
    description: "卸载 systemd 服务",
    handler: async (_args, ctx) => {
      try {
        const { execSync } = await import("node:child_process");
        const { unlinkSync, existsSync } = await import("node:fs");
        const { homedir } = await import("node:os");
        const svcPath = `${homedir()}/.config/systemd/user/pi-feishu-bridge.service`;

        execSync("systemctl --user stop pi-feishu-bridge.service 2>/dev/null", { stdio: "pipe" });
        execSync("systemctl --user disable pi-feishu-bridge.service 2>/dev/null", { stdio: "pipe" });
        execSync("systemctl --user daemon-reload", { stdio: "pipe" });

        if (existsSync(svcPath)) {
          unlinkSync(svcPath);
        }

        ctx.ui.notify("⏹ systemd 服务已卸载", "info");
      } catch (err) {
        ctx.ui.notify(`❌ 卸载失败: ${err}`, "error");
      }
    },
  });

  // ─── /feishu-logs ────────────────────────────────────────
  pi.registerCommand("feishu-logs", {
    description: "查看最近日志",
    getArgumentCompletions: async (prefix: string) => {
      const items = [
        { value: "daemon", label: "daemon — daemon 模式日志文件" },
        { value: "systemd", label: "systemd — journalctl 日志" },
        { value: "tail", label: "tail — 持续跟踪（另开终端）" },
      ];
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const mode = args.trim() || "daemon";

      try {
        const { execSync } = await import("node:child_process");
        const { resolve } = await import("node:path");

        if (mode === "systemd") {
          const log = execSync(
            "journalctl --user -u pi-feishu-bridge --no-pager -n 30",
            { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
          );
          ctx.ui.notify(`📋 **systemd 日志 (最近 30 行):**\n\n\`\`\`\n${log.slice(0, 1500)}\n\`\`\`\n\n跟踪: journalctl --user -u pi-feishu-bridge -f`, "info");
        } else if (mode === "tail") {
          ctx.ui.notify("在另一个终端运行:\njournalctl --user -u pi-feishu-bridge -f", "info");
        } else {
          // 默认读 daemon 日志文件
          const { existsSync, readFileSync } = await import("node:fs");
          const logFile = resolve(".pi/logs/output.log");
          if (existsSync(logFile)) {
            const content = readFileSync(logFile, "utf-8").split("\n").slice(-50).join("\n");
            ctx.ui.notify(`📋 **daemon 日志 (最近 50 行):**\n\n\`\`\`\n${content.slice(0, 1500)}\n\`\`\`\n\n文件: ${logFile}`, "info");
          } else {
            ctx.ui.notify("ℹ️ 未找到 daemon 日志文件", "info");
          }
        }
      } catch (err) {
        ctx.ui.notify(`❌ 读取日志失败: ${err}`, "error");
      }
    },
  });

  // ─── /feishu-config ──────────────────────────────────────
  pi.registerCommand("feishu-config", {
    description: "查看所有配置项及当前值",
    handler: async (_args, ctx) => {
      const store = await getStore();
      const file = store.readConfig();
      const merged = store.mergeWithEnv(file);

      const lines = [
        "📋 **飞书桥接配置**",
        "",
        "**配置文件 (.pi/feishu-config.json):**",
        ...Object.entries(store.CONFIG_KEYS).map(([k, meta]) => {
          const val = (file as any)[k];
          const display = val !== undefined
            ? (meta.secret ? hide(String(val)) : String(val))
            : "—";
          return `  ${k} = ${display}`;
        }),
        "",
        "**最终生效值 (文件 + 环境变量):**",
        `  feishu_app_id     = ${hide(merged.feishuAppId)}`,
        `  feishu_app_secret = ${merged.feishuAppSecret ? "✅ 已配置" : "❌ 未配置"}`,
        `  model             = ${merged.model}`,
        `  thinking_level    = ${merged.thinkingLevel}`,
        `  port              = ${merged.port}`,
        `  timeout           = ${merged.timeout}ms`,
        `  log_level         = ${merged.logLevel}`,
        `  workspaces_dir    = ${merged.workspacesDir}`,
        `  sessions_dir      = ${merged.sessionsDir}`,
        "",
        "**运行方式:**",
        "  /feishu-daemon     后台守护进程（推荐！）",
        "  /feishu-install    systemd 开机自启",
        "  /feishu-start      前台进程（随 pi 退出）",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── /feishu-set ─────────────────────────────────────────
  pi.registerCommand("feishu-set", {
    description: "设置配置项，如: /feishu-set feishu_app_id cli_xxx",
    getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
      const store = await getStore();
      const keys = Object.keys(store.CONFIG_KEYS);
      const items = [
        { value: "reset", label: "reset — 清除所有配置" },
        ...keys.map((k) => ({
          value: k,
          label: `${k} — ${store.CONFIG_KEYS[k].description}`,
        })),
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const store = await getStore();

      if (parts[0] === "reset") {
        const { unlinkSync, existsSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const configPath = resolve(".pi/feishu-config.json");
        if (existsSync(configPath)) {
          unlinkSync(configPath);
          ctx.ui.notify("✅ 配置已重置", "info");
        } else {
          ctx.ui.notify("ℹ️ 没有配置文件需要重置", "info");
        }
        return;
      }

      if (parts.length === 0 || !parts[0]) {
        const lines = [
          "📋 **可用配置项:**",
          ...Object.entries(store.CONFIG_KEYS).map(([k, meta]) => {
            const hint = meta.type === "enum" ? ` (${meta.enum!.join("|")})` : ` (${meta.type})`;
            return `  ${k}${hint}`;
          }),
          "",
          "示例:",
          "  /feishu-set feishu_app_id cli_xxx",
          '  /feishu-set model "anthropic/claude-sonnet-4-20250514"',
          "  /feishu-set reset",
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (parts.length < 2) {
        ctx.ui.notify(`用法: /feishu-set ${parts[0]} <value>`, "error");
        return;
      }

      const key = parts[0];
      const value = parts.slice(1).join(" ");
      const result = store.setConfig(key, value);

      if (result.success) {
        ctx.ui.notify(
          `✅ 已设置 ${key}\n重启桥接生效: /feishu-stop → /feishu-daemon\n或: /feishu-install（systemd 会自启）`,
          "info",
        );
      } else {
        ctx.ui.notify(`❌ ${result.error}`, "error");
      }
    },
  });

  console.log("[feishu-bridge] 扩展已加载");
  console.log("[feishu-bridge] 可用命令: /feishu-status, /feishu-start, /feishu-stop, /feishu-daemon, /feishu-install, /feishu-uninstall, /feishu-logs, /feishu-config, /feishu-set");
}

function hide(val: string): string {
  if (!val || val.length <= 8) return val;
  return val.slice(0, 8) + "****";
}
