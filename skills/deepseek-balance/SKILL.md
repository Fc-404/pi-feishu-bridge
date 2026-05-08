---
name: deepseek-balance
description: 查询 DeepSeek 账户余额、今日 token 用量和花费，以及近7天使用趋势。当用户需要查看 DeepSeek API 账户情况时使用。
---

# DeepSeek 余额查询

## 概述

本技能查询 DeepSeek API 账户余额，并基于 pi 本地会话记录统计 token 用量和花费。

## 工作流程

1. **查找 API 密钥** — 从 `~/.pi/agent/auth.json` 或环境变量 `DEEPSEEK_API_KEY` 获取
2. **查询余额** — 调用 `GET https://api.deepseek.com/user/balance`
3. **统计用量** — 遍历 `~/.pi/agent/sessions/` 下的所有会话文件，按 DeepSeek 官方 USD 定价 × 实时汇率计算花费

## 使用方法

```bash
bash scripts/check-balance.sh
```

## 输出示例

```
余额: ¥1.98

今日: 632 次调用  |  输入(含缓存) 66.7M  |  输出 0.3M
其中缓存命中: 66.3M
今日花费: ¥2.7162

近7天趋势:
  日期   调用      花费  tokens(输入+缓存/输出)
  05-01    0 ¥0.0000  -
  05-07  632 ¥2.7162  66.7M/0.3M ←
```

## 注意

- 用量数据来自 pi 本地会话文件，仅统计通过 pi 发出的 API 调用
- API 密钥由 pi 安全管理，存储在 `~/.pi/agent/auth.json`
