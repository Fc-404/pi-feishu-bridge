/**
 * Token 用量与费用统计
 * 兼容 cny-cost 扩展的定价模型
 */

import { readFileSync, existsSync } from "node:fs";

// ─── 定价（人民币/百万 token） ──────────────────────────────
const PRICING: Record<string, { hit: number; miss: number; out: number }> = {
  "deepseek-v4-pro":    { hit: 0.025, miss: 3,   out: 6   },
  "deepseek-v4-flash":  { hit: 0.02,  miss: 1,   out: 2   },
  "google/gemini-2.5-flash-preview-05-06": { hit: 0, miss: 0.15, out: 0.6 },
  "anthropic/claude-sonnet-4-20250514":    { hit: 1.5, miss: 4.5, out: 22.5 },
  "anthropic/claude-haiku-3-5":            { hit: 0.1, miss: 1, out: 5 },
  "openai/gpt-4o":                         { hit: 1.25, miss: 2.5, out: 10 },
  "openai/o4-mini":                        { hit: 0.15, miss: 0.6, out: 2.4 },
};

/** 计算单次费用 */
export function oneCost(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (cacheRead / 1_000_000) * p.hit +
    (input / 1_000_000) * p.miss +
    (output / 1_000_000) * p.out
  );
}

/** 格式化 token 数 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/** Token 用量快照 */
export interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  total: number;
  cost: number;
  model: string;
}

/** 从 session 文件中提取最近的 assistant 消息用量 */
export function getSessionStats(sessionFile: string): { total: UsageSnapshot; today: number } {
  let totalInput = 0, totalOutput = 0, totalCache = 0;
  let model = "";
  const today = new Date().toISOString().slice(0, 10);

  if (!existsSync(sessionFile)) {
    return { total: { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0, model: "" }, today: 0 };
  }

  const lines = readFileSync(sessionFile, "utf-8").split("\n");
  let todayCostAll = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== "message" || e.message?.role !== "assistant") continue;
      const m = e.message;
      const u = m.usage;
      if (!u) continue;

      const input = u.input || 0;
      const output = u.output || 0;
      const cache = u.cacheRead || 0;
      const curModel = m.model || "";

      totalInput += input;
      totalOutput += output;
      totalCache += cache;
      if (curModel) model = curModel;

      // 计算今日累计
      const ts = e.timestamp || m.timestamp;
      if (ts && new Date(ts).toISOString().startsWith(today)) {
        todayCostAll += oneCost(curModel || model, input, output, cache);
      }
    } catch { /* skip parse errors */ }
  }

  const total = totalInput + totalOutput + totalCache;
  const cost = oneCost(model, totalInput, totalOutput, totalCache);

  return {
    total: { input: totalInput, output: totalOutput, cacheRead: totalCache, total, cost, model },
    today: Math.round(todayCostAll * 1_000_000) / 1_000_000,
  };
}

/** 生成一行摘要文本 */
export function formatUsageLine(stats: UsageSnapshot, todayCost: number): string {
  const parts: string[] = [];
  parts.push(`↑${fmtTokens(stats.input)}`);
  parts.push(`↓${fmtTokens(stats.output)}`);
  if (stats.cacheRead > 0) parts.push(`⚡${fmtTokens(stats.cacheRead)}`);
  parts.push(`∑${fmtTokens(stats.total)}`);
  if (stats.cost > 0) parts.push(`¥${stats.cost.toFixed(3)}`);
  if (todayCost > 0) parts.push(`(今日 ¥${todayCost.toFixed(3)})`);
  return parts.join(" ");
}
