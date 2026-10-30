/**
 * Groq on-demand prices in USD per 1M tokens. Used only by the eval report's cost estimate.
 * Source: https://console.groq.com/docs/model/openai/gpt-oss-20b and
 * https://console.groq.com/docs/model/openai/gpt-oss-120b (retrieved 2026-10-30).
 */
export const PRICING_SOURCE = 'console.groq.com/docs/model pages, retrieved 2026-10-30';

export interface ModelPrice {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'openai/gpt-oss-20b': { inputPerM: 0.075, cachedInputPerM: 0.037, outputPerM: 0.3 },
  'openai/gpt-oss-120b': { inputPerM: 0.15, cachedInputPerM: 0.075, outputPerM: 0.6 },
};

/** Cost of one model's usage. Cached-token discounts are ignored, so this is an upper bound. */
export function costUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = MODEL_PRICES[model];
  if (!p) return 0;
  return (promptTokens * p.inputPerM + completionTokens * p.outputPerM) / 1_000_000;
}
