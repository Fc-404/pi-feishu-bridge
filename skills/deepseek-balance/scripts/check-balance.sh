#!/usr/bin/env bash
set -euo pipefail

# =============================================
# DeepSeek API 账户信息查询
# =============================================

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo -e "${CYAN}   DeepSeek API 账户信息查询${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo ""

# =============================================
# 1. 查找 API 密钥
# =============================================
API_KEY=""
AUTH_FILE="$HOME/.pi/agent/auth.json"
if [ -f "$AUTH_FILE" ]; then
    API_KEY=$(python3 -c "
import json
try:
    with open('$AUTH_FILE') as f:
        data = json.load(f)
    if 'deepseek' in data and 'key' in data['deepseek']:
        print(data['deepseek']['key'])
except:
    pass
" 2>/dev/null || echo "")
fi
if [ -z "$API_KEY" ] && [ -n "${DEEPSEEK_API_KEY:-}" ]; then
    API_KEY="$DEEPSEEK_API_KEY"
fi
if [ -z "$API_KEY" ]; then
    echo -e "${RED}✗ 未找到 DeepSeek API 密钥${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 已找到 API 密钥${NC}  前缀: ${API_KEY:0:8}..."
echo ""

# =============================================
# 2. 查询余额
# =============================================
echo -e "${YELLOW}正在查询账户余额...${NC}"
BALANCE_RESP=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Accept: application/json" \
    "https://api.deepseek.com/user/balance" 2>/dev/null)
HTTP_CODE=$(echo "$BALANCE_RESP" | tail -1)
BALANCE_BODY=$(echo "$BALANCE_RESP" | sed '$d')
if [ "$HTTP_CODE" != "200" ]; then
    echo -e "${RED}✗ 查询失败 (HTTP $HTTP_CODE)${NC}"
    echo "$BALANCE_BODY"
    exit 1
fi
echo -e "${GREEN}✓ 查询成功${NC}"
echo ""

echo -e "${CYAN}── 余额信息 ──${NC}"
python3 -c "
import json
data = json.loads('''$BALANCE_BODY''')
for info in data.get('balance_infos', []):
    total = float(info.get('total_balance', 0))
    print(f'  余额: ¥{total:.2f}')
    if total < 1.0:
        print(f'  ⚠️  余额不足，请注意充值')
"
echo ""

# =============================================
# 3. 用量统计（从 session 文件读取）
# =============================================
echo -e "${CYAN}── 用量统计（基于 pi 会话记录） ──${NC}"

python3 << 'PYEOF'
import json, os, urllib.request
from datetime import datetime, timedelta
from collections import defaultdict

# DeepSeek 官方定价（USD / 百万 tokens）
# 来源: https://api.deepseek.com/pricing
PRICING = {
    "deepseek-v4-flash": {"input": 0.14, "output": 0.28, "cache": 0.0028},
    "deepseek-v4-pro":   {"input": 0.435, "output": 0.87, "cache": 0.003625},
}

# 获取汇率
try:
    rate = json.loads(urllib.request.urlopen(
        "https://api.exchangerate-api.com/v4/latest/USD", timeout=5
    ).read())["rates"]["CNY"]
except:
    rate = 7.0

def calc_cost(model, inp, out, cache):
    """按 DeepSeek 计费方式：
       - cacheRead = 缓存上下文（独立于 input）按 cache 价
       - input = 新输入 tokens 按 input 价
       - output = 输出 tokens 按 output 价"""
    p = PRICING.get(model)
    if not p:
        return 0
    return (inp / 1e6 * p["input"] +
            out / 1e6 * p["output"] +
            cache / 1e6 * p["cache"]) * rate

# 遍历 session 文件
sessions_dir = os.path.expanduser("~/.pi/agent/sessions")
daily = defaultdict(lambda: {"calls": 0, "input": 0, "output": 0, "cache": 0, "cost": 0.0})

MB = lambda n: f"{n/1e6:.1f}M"

def fmt_tokens(inp, out, cache):
    """格式: input+cache/output"""
    total_inp = inp + cache
    return f"{MB(total_inp)}/{MB(out)}"

for root, dirs, files in os.walk(sessions_dir):
    for f in files:
        if not f.endswith(".jsonl"):
            continue
        path = os.path.join(root, f)
        try:
            with open(path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        e = json.loads(line)
                        if (e.get("type") != "message" or
                            e.get("message", {}).get("role") != "assistant"):
                            continue
                        msg = e["message"]
                        ts = e.get("timestamp", msg.get("timestamp", ""))
                        usage = msg.get("usage")
                        if not usage or not ts:
                            continue
                        day = ts[:10]
                        model = msg.get("model", "unknown")
                        inp = usage.get("input", 0)
                        out = usage.get("output", 0)
                        cache = usage.get("cacheRead", 0)
                        d = daily[day]
                        d["calls"] += 1
                        d["input"] += inp
                        d["output"] += out
                        d["cache"] += cache
                        d["cost"] += calc_cost(model, inp, out, cache)
                    except:
                        pass
        except:
            pass

if not daily:
    print("  未找到会话记录")
    exit(0)

today = datetime.now().strftime("%Y-%m-%d")

# 今日统计
if today in daily:
    d = daily[today]
    total_inp = d["input"] + d["cache"]
    print(f"  今日: {d['calls']} 次调用  |  输入(含缓存) {MB(total_inp)}  |  输出 {MB(d['output'])}")
    print(f"  其中缓存命中: {MB(d['cache'])}")
    print(f"  今日花费: ¥{d['cost']:.4f}")
else:
    print("  今日暂无调用记录")
print()

# 近7天趋势
print("  ── 近7天趋势 ──")
print(f"  {'日期':>5} {'调用':>4} {'花费':>7}  tokens(输入+缓存/输出)")
for i in range(6, -1, -1):
    day = (datetime.now() - timedelta(days=i)).strftime("%m-%d")
    d = daily.get((datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d"),
                   {"calls": 0, "cost": 0.0, "input": 0, "output": 0, "cache": 0})
    marker = " ←" if i == 0 else ""
    tok_str = fmt_tokens(d["input"], d["output"], d["cache"]) if d["calls"] > 0 else "-"
    print(f"  {day} {d['calls']:>4d} ¥{d['cost']:>5.4f}  {tok_str}{marker}")

print()
total_calls = sum(d["calls"] for d in daily.values())
total_days = len(daily)
print(f"  共 {total_days} 天 {total_calls} 次调用  |  汇率: 1 USD = {rate} CNY")
PYEOF

echo ""
echo -e "${CYAN}═══════════════════════════════════════${NC}"
