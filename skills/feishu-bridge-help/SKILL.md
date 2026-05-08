---
name: feishu-bridge-help
description: 配置和使用飞书桥接服务的完整指南。当用户询问如何设置飞书机器人、配置环境变量或启动桥接服务时使用。
---

# 飞书桥接使用指南

## 设计理念

飞书桥接是 **pi 的远程终端**，而不是一个独立的多租户服务。

- **同一个工作目录** — 使用 `process.cwd()`，与本地 pi 一致
- **同一个 session** — 所有飞书用户共享一个 pi 会话
- **同一个 AGENTS.md** — 自动加载，无需额外配置
- **同一个 session 存储** — 使用 `~/.pi/agent/sessions/`（pi 默认目录）
- **无用户隔离** — 没有工作区沙箱，没有 per-user 会话

## 快速开始

### 安装

```bash
# 从 GitHub 安装
pi install git:github.com/Fc-404/pi-feishu-bridge
cd ~/.pi/agent/git/github.com/Fc-404/pi-feishu-bridge && npm install && npm run build

# 或本地克隆
git clone https://github.com/Fc-404/pi-feishu-bridge.git
cd pi-feishu-bridge && npm install && npm run build && pi install .
```

### 配置

```bash
# 在 pi TUI 中
/feishu-set feishu_app_id cli_xxxxxxxx
/feishu-set feishu_app_secret xxxxxxxxx
/feishu-set model anthropic/claude-sonnet-4-20250514
```

### 启动

```bash
# 方式一：systemd 开机自启（推荐）
/feishu-install

# 方式二：后台守护进程
/feishu-daemon
```

## 飞书中使用

发送消息给机器人，回复流程：

```
用户发消息 → 👀 处理中 → [AI 回复内容] → ✅ 完成  ↑总输入 ↓总输出 ⚡缓存 🔄次数 ¥费用
```

### 飞书命令

| 命令 | 作用 |
|------|------|
| `/new` | 重建会话，清空上下文 |
| `/stop` | 中止当前处理（上下文保留） |
| `/compact` | 压缩上下文，释放 token 空间 |
| `/help` | 查看帮助 |

### 提示词与记忆

桥接服务使用 pi 原生的 AGENTS.md 机制，与本地 pi 完全一致：

- **AGENTS.md**：定义 agent 行为和规则，自动加载到系统提示词
- **记忆管理**：在 AGENTS.md 中要求 agent 读写 `memory.md` 文件即可
- 无需独立的 `feishu-prompt.md` 或 `feishu-memory.md`

## pi TUI 命令

安装本包后可用以下命令：

| 命令 | 说明 |
|------|------|
| `/feishu-status` | 查看前台/daemon/systemd 运行状态 |
| `/feishu-start` | 启动前台进程（依附于 pi） |
| `/feishu-daemon` | 启动后台守护进程 |
| `/feishu-stop` | 停止前台 + daemon 进程 |
| `/feishu-install` | 安装 systemd 服务（开机自启 + 崩溃重启） |
| `/feishu-uninstall` | 卸载 systemd 服务 |
| `/feishu-logs [daemon\|systemd]` | 查看日志 |
| `/feishu-config` | 查看完整配置 |
| `/feishu-set <key> <val>` | 设置配置项 |
| `/feishu-agents` | 查看 AGENTS.md 内容 |

## 卸载

```bash
/feishu-uninstall                # 卸载 systemd 服务
pi remove pi-feishu-bridge       # 移除 pi 包
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书 App ID (必填) | - |
| `FEISHU_APP_SECRET` | 飞书 App Secret (必填) | - |
| `PI_FEISHU_MODEL` | 模型 | google/gemini-2.5-flash-preview-05-06 |
| `PI_FEISHU_THINKING` | Thinking 等级 | off |
| `PI_FEISHU_TIMEOUT` | 超时(ms) | 300000 |
| `PI_FEISHU_SESSIONS` | 会话存储目录 | (默认 ~/.pi/agent/sessions/) |
| `PORT` | 健康检查端口 | 3700 |

## 架构

```
飞书 App ──WebSocket──→ pi-feishu-bridge ──SDK──→ pi AgentSession
                            │
                   ┌────────┴────────┐
                   │  ~/.pi/agent/   │
                   │  ├─ sessions/   │
                   │  ├─ AGENTS.md   │
                   │  └─ settings    │
                   └─────────────────┘
```
