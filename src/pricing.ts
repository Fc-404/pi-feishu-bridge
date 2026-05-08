/**
 * 模型定价（人民币/百万 token）
 *
 * 与 cny-cost 扩展共享同一套定价。
 * 桥接服务读 session 文件后，用此定价计算费用。
 */

export const PRICING: Record<string, { hit: number; miss: number; out: number }> = {
  "deepseek-v4-pro":   { hit: 0.025, miss: 3, out: 6 },
  "deepseek-v4-flash": { hit: 0.02,  miss: 1, out: 2 },
};

/** 计算单次 LLM 调用的费用（人民币） */
export function oneCost(model: string, input: number, output: number, cacheRead: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (cacheRead / 1_000_000) * p.hit + (input / 1_000_000) * p.miss + (output / 1_000_000) * p.out;
}
