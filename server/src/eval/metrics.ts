import { URGENCY_RANK, type TradeOrUnknown, type Urgency } from '@fia/shared';
import type { CaseSource, EvalCase, EvalCategory } from './cases';

/** What the pipeline produced for one case, reduced to the graded fields. */
export interface Prediction {
  trade: TradeOrUnknown;
  assetId: string | null;
  urgency: Urgency;
  duplicateOf: string | null;
  needsHuman: boolean;
  /** A code safety rule fired and the result is emergency. */
  safetyEmergency: boolean;
  escalated: boolean;
  modelUsed: string | null;
}

export interface CaseResult {
  id: string;
  category: EvalCategory;
  source: CaseSource;
  inputText: string;
  expected: EvalCase['expected'];
  /** null when the pipeline crashed or the model call failed outright. */
  predicted: Prediction | null;
  error: string | null;
  latencyMs: number;
  tokens: number;
}

export type Field = 'trade' | 'assetId' | 'urgency' | 'duplicateOf' | 'needsHuman' | 'safety';

export interface Mismatch {
  field: Field;
  expected: string;
  got: string;
}

const show = (v: unknown): string => (v === null ? 'null' : String(v));

export function mismatches(r: CaseResult): Mismatch[] {
  const e = r.expected;
  const p = r.predicted;
  if (!p) return [{ field: 'trade', expected: show(e.trade), got: `error: ${r.error ?? '?'}` }];
  const out: Mismatch[] = [];
  const check = (field: Field, exp: unknown, got: unknown) => {
    if (exp !== got) out.push({ field, expected: show(exp), got: show(got) });
  };
  check('trade', e.trade, p.trade);
  check('assetId', e.assetId, p.assetId);
  check('urgency', e.urgency, p.urgency);
  check('duplicateOf', e.duplicateOf, p.duplicateOf);
  check('needsHuman', e.needsHuman, p.needsHuman);
  check('safety', e.safetyEmergency, p.safetyEmergency);
  return out;
}

export interface Ratio {
  hit: number;
  of: number;
}

export interface PrecisionRecall {
  precision: Ratio;
  recall: Ratio;
}

export interface Metrics {
  cases: number;
  errors: number;
  passed: number;
  trade: Ratio;
  asset: Ratio;
  urgency: Ratio;
  urgencyWithinOne: Ratio;
  /** Predicted less urgent than expected. */
  underCalls: Ratio;
  safetyRecall: Ratio;
  /** Safety rule fired where the label says it should not. */
  safetyFalseAlarms: Ratio;
  duplicate: PrecisionRecall;
  needsHuman: PrecisionRecall;
  escalated: Ratio;
  latency: { avgMs: number; p95Ms: number };
  tokens: { total: number; avgPerCase: number };
  byCategory: Record<string, { cases: number; passed: number }>;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function computeMetrics(results: CaseResult[]): Metrics {
  const ratio = (pred: (r: CaseResult) => boolean, of: CaseResult[] = results): Ratio => ({
    hit: of.filter(pred).length,
    of: of.length,
  });
  const p = (r: CaseResult) => r.predicted;

  const urgencyDiff = (r: CaseResult): number | null =>
    p(r) ? URGENCY_RANK[p(r)!.urgency] - URGENCY_RANK[r.expected.urgency] : null;

  const safetyCases = results.filter((r) => r.expected.safetyEmergency);
  const nonSafety = results.filter((r) => !r.expected.safetyEmergency);

  // Duplicates: a positive is "merge into this specific open work order".
  const predictedDup = results.filter((r) => p(r)?.duplicateOf);
  const expectedDup = results.filter((r) => r.expected.duplicateOf);
  const dupCorrect = (r: CaseResult) =>
    !!r.expected.duplicateOf && p(r)?.duplicateOf === r.expected.duplicateOf;

  const predictedHuman = results.filter((r) => p(r)?.needsHuman);
  const expectedHuman = results.filter((r) => r.expected.needsHuman);

  const byCategory: Metrics['byCategory'] = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { cases: 0, passed: 0 });
    c.cases += 1;
    if (mismatches(r).length === 0) c.passed += 1;
  }

  const latencies = results.filter((r) => p(r)).map((r) => r.latencyMs);
  const tokens = results.reduce((s, r) => s + r.tokens, 0);

  return {
    cases: results.length,
    errors: results.filter((r) => !p(r)).length,
    passed: results.filter((r) => mismatches(r).length === 0).length,
    trade: ratio((r) => p(r)?.trade === r.expected.trade),
    asset: ratio((r) => !!p(r) && p(r)!.assetId === r.expected.assetId),
    urgency: ratio((r) => urgencyDiff(r) === 0),
    urgencyWithinOne: ratio((r) => {
      const d = urgencyDiff(r);
      return d !== null && Math.abs(d) <= 1;
    }),
    underCalls: ratio((r) => {
      const d = urgencyDiff(r);
      return d === null || d < 0;
    }),
    safetyRecall: ratio((r) => p(r)?.safetyEmergency === true, safetyCases),
    safetyFalseAlarms: ratio((r) => p(r)?.safetyEmergency === true, nonSafety),
    duplicate: {
      precision: { hit: predictedDup.filter(dupCorrect).length, of: predictedDup.length },
      recall: { hit: expectedDup.filter(dupCorrect).length, of: expectedDup.length },
    },
    needsHuman: {
      precision: {
        hit: predictedHuman.filter((r) => r.expected.needsHuman).length,
        of: predictedHuman.length,
      },
      recall: {
        hit: expectedHuman.filter((r) => p(r)?.needsHuman).length,
        of: expectedHuman.length,
      },
    },
    escalated: ratio((r) => p(r)?.escalated === true),
    latency: {
      avgMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      p95Ms: percentile(latencies, 95),
    },
    tokens: { total: tokens, avgPerCase: results.length ? tokens / results.length : 0 },
    byCategory,
  };
}

/** Safety recall must be 100%. An empty safety subset is not a failure. */
export function safetyPassed(m: Metrics): boolean {
  return m.safetyRecall.hit === m.safetyRecall.of;
}
