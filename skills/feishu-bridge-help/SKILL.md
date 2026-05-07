---
name: feishu-bridge-help
description: 配置和使用飞书桥接服务的完整指南。当用户询问如何设置飞书机器人、配置环境变量或启动桥接服务时使用。
---

# 飞书桥接使用指南

当被问到如何配置或使用飞书桥接服务时，参考以下信息。

## 快速开始

### 1. 安装桥接服务

```bash
pi install ./pi-feishu-bridge          # 本地安装
# 或
pi install npm:pi-feishu-bridge         # 未来发布到 npm 后
```

### 2. 配置飞书应用

在 [飞书开发者后台](https://open.feishu.cn/app) 创建企业自建应用：

1. 创建应用，获取 **App ID** 和 **App Secret**
2. 开启 **机器人** 能力
3. 事件订阅 → 添加事件 `im.message.receive_v1`
4. 订阅方式选择 **WebSocket**（你已开启）
5. 发布应用

### 3. 启动服务

```bash
export FEISHU_APP_ID=cli_xxxxxxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 启动桥接
npx pi-feishu

# 或通过 pi 扩展启动（先安装本包）
# 在 pi TUI 中输入 /feishu-start
```

### 4. 在飞书中使用

- 给机器人发送私聊消息
- 在群聊中 @机器人 提问
- 机器人会调用 pi 编码助手进行处理并回复

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书 App ID (必填) | - |
| `FEISHU_APP_SECRET` | 飞书 App Secret (必填) | - |
| `PORT` | 健康检查端口 | 3700 |
| `PI_FEISHU_MODEL` | 使用的模型 | google/gemini-2.5-flash-preview-05-06 |
| `PI_FEISHU_THINKING` | Thinking 等级 | off |
| `PI_FEISHU_TIMEOUT` | 超时(ms) | 300000 |
| `PI_FEISHU_WORKSPACES` | 工作目录 | ./workspaces |
| `PI_FEISHU_SESSIONS` | 会话存储目录 | ./sessions |

## pi TUI 命令

安装本包后，在 pi 中使用:

- `/feishu-status` - 查看服务状态
- `/feishu-start` - 启动桥接
- `/feishu-stop` - 停止桥接
- `/feishu-config` - 查看配置

## 架构

```
飞书 App ──WebSocket──→ pi-feishu-bridge ──SDK──→ pi Agent
                               │
                    ┌──────────┴──────────┐
                    │    sessions/         │
                    │    workspaces/       │
                    └─────────────────────┘
```

每个飞书用户/群聊在 pi 中有独立的 session，对话历史自动持久化。
