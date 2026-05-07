# pi-feishu-bridge 🚀

飞书（Lark）↔ [pi coding agent](https://github.com/badlogic/pi-mono) 实时对话桥接服务。

通过飞书机器人直接与 pi 编码助手对话，支持私聊和群聊，每个用户/群聊独立持久化会话，流式输出（类 ChatGPT 打字机效果）。

---

## 目录

- [架构总览](#架构总览)
- [快速开始](#快速开始)
- [配置方式](#配置方式)
- [运行方式（三种）](#运行方式三种)
- [Pi 包安装（推荐）](#pi-包安装推荐)
- [全部命令](#全部命令)
- [文件结构](#文件结构)
- [开发指南](#开发指南)
- [License](#license)

---

## 架构总览

```
                飞书 WebSocket
飞书 App ─────────────────────→ pi-feishu-bridge ──SDK──→ pi Agent (LLM)
                                     │
                            ┌────────┴────────┐
                            │  sessions/       │  ← 每个用户/群聊独立 JSONL 会话
                            │  workspaces/     │  ← 每个用户隔离的工作目录
                            │  .pi/            │  ← 配置文件
                            └─────────────────┘
```

核心设计：

- **SDK 直嵌**：使用 `@mariozechner/pi-coding-agent` SDK 直接在 Node.js 进程中调用 pi，零序列化开销
- **LarkChannel**：使用飞书官方 `@larksuiteoapi/node-sdk` 的 WebSocket API，自动重连
- **流式输出**：飞书 Markdown Stream 实时推送，用户看到打字机效果
- **多会话**：每个飞书用户/群聊独立持久化 session（JSONL 树结构），支持断点续聊
- **自动清理**：30 分钟无活动自动释放空闲 session

---

## 快速开始

### 前置条件

1. 已安装 [pi coding agent](https://github.com/badlogic/pi-mono) 并配置好 API Key
2. 在 [飞书开发者后台](https://open.feishu.cn/app) 创建企业自建应用：
   - 获取 **App ID** 和 **App Secret**
   - 开启 **机器人** 能力
   - 事件订阅 → 添加 `im.message.receive_v1` → 订阅方式选择 **WebSocket**
   - 发布应用

### 一键启动

```bash
FEISHU_APP_ID=cli_xxxxxxxx FEISHU_APP_SECRET=xxxxxxxx npx pi-feishu
```

> 也可以先配好再启动，见下方[配置方式](#配置方式)。

---

## 配置方式

### 方式 A：命令行配置（推荐，保存在配置文件）

在 pi TUI 中使用 `/feishu-set` 命令配置，保存到 `.pi/feishu-config.json`：

```
/feishu-set feishu_app_id cli_a7f9b2c1d3e4f5
/feishu-set feishu_app_secret xxxxxxxxxx
/feishu-set model anthropic/claude-sonnet-4-20250514
/feishu-set thinking_level off
/feishu-set timeout 300000
```

所有可配置项：

| 配置键 | 说明 | 类型 | 默认值 |
|--------|------|------|--------|
| `feishu_app_id` | 飞书 App ID | string | — |
| `feishu_app_secret` | 飞书 App Secret | string (secret) | — |
| `model` | 模型 (provider/id 格式) | string | `google/gemini-2.5-flash-preview-05-06` |
| `thinking_level` | Thinking 等级 | enum | `off` |
| `port` | 健康检查端口 | number | `3700` |
| `timeout` | 超时毫秒 | number | `300000` |
| `log_level` | 日志等级 | enum | `info` |
| `workspaces_dir` | 工作目录 | string | `./workspaces` |
| `sessions_dir` | 会话存储目录 | string | `./sessions` |

### 方式 B：环境变量

```bash
export FEISHU_APP_ID=cli_xxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxx
export PI_FEISHU_MODEL=anthropic/claude-sonnet-4-20250514
npx pi-feishu
```

### 配置优先级

```
环境变量（最高）→ .pi/feishu-config.json（项目配置）→ 默认值
```

### 推荐模型

| 模型 | 特点 |
|------|------|
| `google/gemini-2.5-flash-preview-05-06` | 速度快，适合对话（默认） |
| `anthropic/claude-sonnet-4-20250514` | 编码能力强 |
| `openai/gpt-4o` | 综合均衡 |
| `openai/o4-mini` | 性价比高 |

---

## 运行方式（三种）

本服务提供三种运行模式，按推荐程度排列：

### ⭐ 方式 1：systemd 系统服务（最稳固，推荐）

通过 systemd 用户服务管理，**开机自启 + 崩溃自动重启**。

```bash
# 在 pi TUI 中配置并安装
/feishu-set feishu_app_id cli_xxx
/feishu-set feishu_app_secret xxx
/feishu-install
```

安装后：

```bash
# 查看状态
systemctl --user status pi-feishu-bridge

# 查看日志
journalctl --user -u pi-feishu-bridge -f

# 手动管理
systemctl --user stop pi-feishu-bridge
systemctl --user restart pi-feishu-bridge

# 卸载
/feishu-uninstall
```

**特性**：
- ✅ 开机自启（`systemctl --user enable`）
- ✅ 崩溃 5 秒后自动重启（`Restart=always`）
- ✅ 日志通过 journald 管理
- ✅ 配置变更后运行 `pi-feishu --export-env` 重新生成环境文件

### ⭐ 方式 2：后台 daemon 进程（推荐）

完全独立于 pi 进程，pi 退出也不影响。

```bash
# 在 pi TUI 中
/feishu-daemon
```

日志写入 `.pi/logs/output.log`，用 `/feishu-logs` 查看。

### 方式 3：前台进程

依附于 pi TUI 进程，pi 退出后桥接也会退出。适合临时测试。

```bash
# 在 pi TUI 中
/feishu-start
```

---

## Pi 包安装（推荐）

将本桥接安装为 pi 包，**所有命令直接在 pi TUI 中使用**。

```bash
# 本地安装
pi install /path/to/pi-feishu-bridge

# 或从 npm 安装（发布后）
pi install npm:pi-feishu-bridge
```

安装后，在 pi TUI 中即可使用全部命令：

```
/feishu-set feishu_app_id cli_xxx
/feishu-set feishu_app_secret xxx
/feishu-install          ← 一键安装为系统服务
```

也可临时加载测试：

```bash
pi -e /path/to/pi-feishu-bridge/extensions/feishu-bridge.ts
```

### CLI 独立使用

无需 pi 也能独立运行：

```bash
# 前台运行
FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx npx pi-feishu

# 后台守护进程
npx pi-feishu --daemon --log-dir ./logs

# 生成 systemd 环境文件
npx pi-feishu --export-env
```

---

## 全部命令

### pi TUI 命令

| 命令 | 说明 |
|------|------|
| `/feishu-status` | 查看前台/daemon/systemd 三种运行状态 |
| `/feishu-start` | 启动前台进程（依附于 pi） |
| `/feishu-daemon` | 启动后台守护进程 |
| `/feishu-stop` | 停止前台 + daemon 进程 |
| `/feishu-install` | 安装 systemd 用户服务（开机自启 + 崩溃重启） |
| `/feishu-uninstall` | 卸载 systemd 服务 |
| `/feishu-logs [daemon\|systemd]` | 查看最近日志 |
| `/feishu-config` | 查看所有配置项及当前值 |
| `/feishu-set [key value]` | 设置配置项，Tab 键自动补全 |

### CLI 命令

| 命令 | 说明 |
|------|------|
| `pi-feishu` | 前台运行 |
| `pi-feishu --daemon` | 后台守护进程 |
| `pi-feishu --export-env` | 从配置文件生成 systemd 环境文件 |
| `pi-feishu --help` | 查看帮助 |

---

## 文件结构

```
pi-feishu-bridge/
├── package.json                  ← pi 包清单 (pi 字段声明扩展 + skill)
├── tsconfig.json
├── README.md
├── .env.example
├── .gitignore
├── src/
│   ├── bin/start.ts              ← CLI 入口 (pi-feishu 命令)
│   ├── config.ts                 ← 配置加载（文件 + 环境变量合并）
│   ├── config-store.ts           ← 配置文件读写 (.pi/feishu-config.json)
│   ├── feishu-client.ts          ← 飞书 LarkChannel WebSocket 集成
│   ├── server.ts                 ← 桥接服务主逻辑（流式输出 + 会话管理）
│   ├── session-manager.ts        ← pi AgentSession 池管理
│   └── types.ts                  ← 共享类型
├── extensions/
│   └── feishu-bridge.ts          ← pi 扩展 (9 个命令)
├── skills/
│   └── feishu-bridge-help/
│       └── SKILL.md              ← skill 文档
└── systemd/
    └── pi-feishu-bridge.service  ← systemd 服务模板
```

---

## 开发指南

```bash
# 克隆
git clone https://github.com/你的用户名/pi-feishu-bridge.git
cd pi-feishu-bridge

# 安装依赖
npm install

# 构建
npm run build

# 开发模式（热重载）
npx tsx src/bin/start.ts

# 本地安装到 pi
pi install .

# 测试扩展
pi -e ./extensions/feishu-bridge.ts
```

### 调试日志

```bash
# 查看 daemon 日志
/feishu-logs daemon

# 查看 systemd 日志
/feishu-logs systemd
# 或直接
journalctl --user -u pi-feishu-bridge -f

# 前台运行并查看详细日志
PI_FEISHU_LOG_LEVEL=debug npx pi-feishu
```

---

## License

MIT
