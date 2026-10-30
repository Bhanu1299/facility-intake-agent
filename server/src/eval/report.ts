import { costUsd, MODEL_PRICES, PRICING_SOURCE } from '../config/pricing';
import type { EvalSet } from './cases';
import {
  computeMetrics,
  mismatches,
  safetyPassed,
  type CaseResult,
  type Metrics,
  type PrecisionRecall,
  type Ratio,
} from './metrics';
import type { ModelUsage } from './pacer';

export interface ReportInput {
  set: EvalSet;
  results: CaseResult[];
  usage: Map<string, ModelUsage>;
  models: { small: string; big: string };
  startedAt: Date;
  durationMs: number;
  pacing: { tokensPerMinute: number; requestsPerMinute: number; waitedMs: number };
  skipped: { id: string; reason: string }[];
}

const pct = (r: Ratio): string =>
  r.of === 0 ? 'n/a' : `${((100 * r.hit) / r.of).toFixed(1)}% (${r.hit}/${r.of})`;
const pr = (x: PrecisionRecall): string =>
  `precision ${pct(x.precision)} · recall ${pct(x.recall)}`;
const ms = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
const usd = (n: number): string => `$${n.toFixed(n < 0.01 ? 5 : 4)}`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function metricsTable(m: Metrics): string {
  const safety = safetyPassed(m) ? 'PASS' : '**FAIL**';
  const rows: [string, string][] = [
    ['Cases (all fields correct)', `${m.cases} (${pct({ hit: m.passed, of: m.cases })})`],
    ['Trade accuracy', pct(m.trade)],
    ['Asset accuracy', pct(m.asset)],
    ['Urgency accuracy (exact)', pct(m.urgency)],
    ['Urgency within one level', pct(m.urgencyWithinOne)],
    ['Urgency under-calls (less urgent than labeled)', pct(m.underCalls)],
    ['Safety recall (must be 100%)', `${pct(m.safetyRecall)} ${safety}`],
    ['Safety rule false alarms', pct(m.safetyFalseAlarms)],
    ['Duplicate detection', pr(m.duplicate)],
    ['Needs-human flag', pr(m.needsHuman)],
    ['Escalated to big model', pct(m.escalated)],
    ['Latency avg / p95', `${ms(m.latency.avgMs)} / ${ms(m.latency.p95Ms)}`],
    ['Tokens total / avg per case', `${m.tokens.total} / ${Math.round(m.tokens.avgPerCase)}`],
    ['Pipeline errors', String(m.errors)],
  ];
  return ['| Metric | Result |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join(
    '\n',
  );
}

function categoryTable(m: Metrics): string {
  return [
    '| Category | Cases | All fields correct |',
    '| --- | --- | --- |',
    ...Object.entries(m.byCategory).map(
      ([cat, c]) => `| ${cat} | ${c.cases} | ${pct({ hit: c.passed, of: c.cases })} |`,
    ),
  ].join('\n');
}

function failedTable(results: CaseResult[]): string {
  const failed = results.filter((r) => mismatches(r).length > 0);
  if (!failed.length) return '_No failed cases._';
  return [
    '| Case | Source | Category | Input | Wrong fields (expected → got) |',
    '| --- | --- | --- | --- | --- |',
    ...failed.map((r) => {
      const input = r.inputText.length > 90 ? `${r.inputText.slice(0, 87)}…` : r.inputText;
      const wrong = mismatches(r)
        .map((x) => `${x.field}: ${x.expected} → ${x.got}`)
        .join('; ');
      return `| ${r.id} | ${r.source} | ${r.category} | ${cell(input)} | ${cell(wrong)} |`;
    }),
  ].join('\n');
}

function costSection(input: ReportInput): string {
  let total = 0;
  const rows = [...input.usage.entries()].map(([model, u]) => {
    const c = costUsd(model, u.promptTokens, u.completionTokens);
    total += c;
    const price = MODEL_PRICES[model];
    const priceText = price
      ? `$${price.inputPerM} in / $${price.outputPerM} out per 1M`
      : 'unknown';
    return `| ${model} | ${u.calls} | ${u.promptTokens} | ${u.completionTokens} | ${priceText} | ${usd(c)} |`;
  });
  const n = input.results.length || 1;
  return [
    '| Model | Calls | Prompt tokens | Completion tokens | Price | Cost |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    `| **Total** | | | | | **${usd(total)}** (${usd(total / n)} per case) |`,
    '',
    `Prices: ${PRICING_SOURCE}. Cached-input discounts are ignored, so this is an upper bound.`,
  ].join('\n');
}

export function renderReport(input: ReportInput): string {
  const { set, results } = input;
  const all = computeMetrics(results);
  const out: string[] = [];
  out.push(`# Eval report: ${set}`);
  out.push('');
  out.push('Test cases and expected answers were written by the author.');
  if (set === 'holdout') {
    out.push(
      'The holdout has two halves: cases written by the AI author (`ai`) and cases written by a human reviewer (`human`). Neither was used for prompt tuning.',
    );
  }
  out.push('');
  out.push(
    `Run ${input.startedAt.toISOString()} · ${results.length} cases · small model \`${input.models.small}\`, big model \`${input.models.big}\` · wall time ${ms(input.durationMs)}`,
  );
  out.push(
    `Paced for the Groq free tier: ≤${input.pacing.requestsPerMinute} requests and ≤${input.pacing.tokensPerMinute} tokens per minute per model (waited ${ms(input.pacing.waitedMs)} in total; not counted in latency). Each case runs on a freshly reseeded in-memory database.`,
  );
  if (input.skipped.length) {
    out.push('');
    out.push(
      `Skipped ${input.skipped.length} human holdout slot(s) that are empty or invalid: ${input.skipped.map((s) => s.id).join(', ')}.`,
    );
  }
  out.push('');

  const verdict = safetyPassed(all)
    ? '**Safety recall: PASS (100%).**'
    : `**Safety recall: FAIL (${pct(all.safetyRecall)}). Safety recall must be 100%.**`;
  out.push(verdict);
  out.push('');

  const sections: [string, CaseResult[]][] =
    set === 'holdout'
      ? [
          ['AI-written cases', results.filter((r) => r.source === 'ai')],
          ['Human-written cases', results.filter((r) => r.source === 'human')],
          ['Combined', results],
        ]
      : [['Results', results]];

  for (const [title, subset] of sections) {
    out.push(`## ${title}`);
    out.push('');
    if (!subset.length) {
      out.push('_No cases._');
      out.push('');
      continue;
    }
    const m = computeMetrics(subset);
    out.push(metricsTable(m));
    out.push('');
    out.push(categoryTable(m));
    out.push('');
  }

  out.push('## Tokens and cost');
  out.push('');
  out.push(costSection(input));
  out.push('');
  out.push('## Failed cases');
  out.push('');
  out.push(failedTable(results));
  out.push('');
  out.push('## How to read this');
  out.push('');
  out.push(
    [
      '- A case passes only if trade, asset, urgency, duplicate, needs-human and safety all match the label.',
      '- Safety recall counts labeled safety emergencies where a code safety rule fired and the result was Emergency.',
      '- Duplicate precision/recall treat "merge into work order X" as the positive; merging into the wrong order is a miss.',
      '- Latency is end-to-end pipeline time per case (all model calls and database work), excluding time spent waiting for the rate-limit window.',
    ].join('\n'),
  );
  out.push('');
  return out.join('\n');
}
