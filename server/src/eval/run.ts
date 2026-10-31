/**
 * Eval runner: `npm run eval -- --set tune|holdout [--only id,id]`.
 *
 * Always runs in-process on an in-memory MongoDB (it never connects to MONGODB_URI), reseeding
 * before every case so cases can't affect each other. Writes eval/report-<set>.md and exits
 * non-zero if safety recall is below 100%.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../env';
import { connectDb, disconnectDb } from '../db';
import { OpenAiCompatibleClient } from '../llm/client';
import { createSignal, runPipeline } from '../pipeline/pipeline';
import { resetDemoData } from '../seed/reset';
import { EVAL_DIR, loadEvalSet, type EvalSet, type LoadedCase } from './cases';
import { computeMetrics, mismatches, safetyPassed, type CaseResult } from './metrics';
import { PacedLlmClient } from './pacer';
import { renderReport } from './report';

const HUMAN_HOLDOUT_SIZE = 10;
const MAX_CONSECUTIVE_LLM_FAILURES = 3;

interface Args {
  set: EvalSet;
  only: string[] | null;
  allowIncompleteHuman: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const set = get('--set');
  if (set !== 'tune' && set !== 'holdout') {
    throw new Error('Usage: npm run eval -- --set tune|holdout [--only id,id]');
  }
  const only = get('--only');
  return {
    set,
    only: only ? only.split(',').map((s) => s.trim()) : null,
    allowIncompleteHuman: argv.includes('--allow-incomplete-human'),
  };
}

async function runCase(c: LoadedCase, llm: PacedLlmClient, models: { small: string; big: string }) {
  const now = new Date();
  await resetDemoData('propose', now);
  const errorsBefore = llm.errors;
  const waitedBefore = llm.waitedMs;
  const started = Date.now();
  try {
    const { id: signalId } = await createSignal(c.input, now);
    const p = await runPipeline(signalId, { llm, models, now: () => now });
    const latencyMs = Date.now() - started - (llm.waitedMs - waitedBefore);
    const llmFailures = llm.errors - errorsBefore;
    const result: CaseResult = {
      id: c.id,
      category: c.category,
      source: c.source,
      inputText: p.inputText,
      expected: c.expected,
      predicted: {
        trade: p.draft.trade,
        assetId: p.draft.assetId,
        urgency: p.draft.urgency,
        duplicateOf: p.duplicate?.workOrderId ?? null,
        needsHuman: p.needsHuman,
        safetyEmergency: !!p.safetyRule && p.draft.urgency === 'emergency',
        escalated: p.escalated,
        modelUsed: p.modelUsed,
      },
      error: llmFailures ? `${llmFailures} model call(s) failed after retries` : null,
      latencyMs,
      tokens: p.usage.totalTokens,
    };
    return result;
  } catch (err) {
    return {
      id: c.id,
      category: c.category,
      source: c.source,
      inputText: c.input.type === 'request' ? c.input.text : `sensor ${c.input.assetId}`,
      expected: c.expected,
      predicted: null,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
      tokens: 0,
    } satisfies CaseResult;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  if (!env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set (put it in .env). The eval needs a real model.');
    return 2;
  }

  const loaded = loadEvalSet(args.set);
  let cases = loaded.cases;
  if (args.set === 'holdout') {
    const human = cases.filter((c) => c.source === 'human').length;
    if (human < HUMAN_HOLDOUT_SIZE && !args.allowIncompleteHuman) {
      console.error(
        `Only ${human}/${HUMAN_HOLDOUT_SIZE} human holdout cases are filled in ` +
          '(eval/cases.holdout.human.json). Fill them in first, or pass --allow-incomplete-human.',
      );
      return 2;
    }
  }
  if (args.only) {
    const wanted = new Set(args.only);
    cases = cases.filter((c) => wanted.has(c.id));
  }
  if (!cases.length) {
    console.error('No cases to run.');
    return 2;
  }

  const models = { small: env.LLM_MODEL_SMALL, big: env.LLM_MODEL_BIG };
  const pacing = {
    tokensPerMinute: Number(process.env.EVAL_TPM ?? 7000),
    requestsPerMinute: Number(process.env.EVAL_RPM ?? 25),
  };
  const llm = new PacedLlmClient(
    new OpenAiCompatibleClient({ apiKey: env.GROQ_API_KEY, baseURL: env.LLM_BASE_URL }),
    pacing,
  );

  // Deliberately '' (not env.MONGODB_URI): the eval must never touch a real database.
  await connectDb('', 'development');
  const startedAt = new Date();
  const results: CaseResult[] = [];
  let consecutiveFailures = 0;
  try {
    for (const [i, c] of cases.entries()) {
      const r = await runCase(c, llm, models);
      results.push(r);
      const wrong = mismatches(r);
      const status = wrong.length ? `✗ ${wrong.map((w) => w.field).join(',')}` : '✓';
      console.log(
        `[${String(i + 1).padStart(2)}/${cases.length}] ${c.id.padEnd(14)} ${status}${r.error ? `  (${r.error})` : ''}`,
      );
      consecutiveFailures = r.error ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_LLM_FAILURES) {
        console.error(
          `Aborting: ${consecutiveFailures} cases in a row had model failures (rate limit or outage). No report written.`,
        );
        return 3;
      }
    }
  } finally {
    await disconnectDb();
  }

  const partial = !!args.only;
  const report = renderReport({
    set: args.set,
    results,
    usage: llm.usage,
    models,
    startedAt,
    durationMs: Date.now() - startedAt.getTime(),
    pacing: { ...pacing, waitedMs: llm.waitedMs },
    skipped: loaded.skipped,
  });
  const file = path.join(EVAL_DIR, `report-${args.set}${partial ? '-partial' : ''}.md`);
  fs.writeFileSync(file, report);

  const m = computeMetrics(results);
  const pct = (h: number, o: number) => (o ? `${((100 * h) / o).toFixed(1)}%` : 'n/a');
  console.log('');
  console.log(
    `passed ${m.passed}/${m.cases} · trade ${pct(m.trade.hit, m.trade.of)} · asset ${pct(m.asset.hit, m.asset.of)} · urgency ${pct(m.urgency.hit, m.urgency.of)} · safety recall ${pct(m.safetyRecall.hit, m.safetyRecall.of)}`,
  );
  console.log(`report: ${path.relative(process.cwd(), file)}`);
  if (!safetyPassed(m)) {
    console.error('FAIL: safety recall is below 100%.');
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
