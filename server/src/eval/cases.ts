import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SignalInput, TradeOrUnknown, Urgency } from '@fia/shared';

export const EVAL_CATEGORIES = [
  'easy',
  'messy',
  'emergency',
  'duplicate',
  'sensor',
  'needs_human',
  'spanish',
] as const;
export const EvalCategory = z.enum(EVAL_CATEGORIES);
export type EvalCategory = z.infer<typeof EvalCategory>;

export const EvalCase = z.object({
  id: z.string().min(1),
  category: EvalCategory,
  input: SignalInput,
  expected: z.object({
    trade: TradeOrUnknown,
    assetId: z.string().nullable(),
    urgency: Urgency,
    duplicateOf: z.string().nullable(),
    needsHuman: z.boolean(),
    safetyEmergency: z.boolean(),
  }),
  note: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;

export type EvalSet = 'tune' | 'holdout';
export type CaseSource = 'tune' | 'ai' | 'human';

export const EVAL_DIR = path.resolve(__dirname, '../../../eval');

export interface LoadedCase extends EvalCase {
  source: CaseSource;
}

export interface LoadResult {
  cases: LoadedCase[];
  /** Human-template slots that are still empty or invalid (skipped, reported). */
  skipped: { id: string; reason: string }[];
}

function readJson(file: string): unknown[] {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, file), 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file} must contain a JSON array`);
  return raw;
}

function parseFile(file: string, source: CaseSource, strict: boolean): LoadResult {
  const cases: LoadedCase[] = [];
  const skipped: LoadResult['skipped'] = [];
  for (const entry of readJson(file)) {
    const rec = entry as { id?: string; example?: boolean };
    if (rec.example) continue;
    const parsed = EvalCase.safeParse(entry);
    if (parsed.success) {
      cases.push({ ...parsed.data, source });
    } else if (strict) {
      throw new Error(`${file}: invalid case ${rec.id ?? '?'}: ${z.prettifyError(parsed.error)}`);
    } else {
      // Don't echo case contents: holdout cases stay unseen until the holdout run.
      skipped.push({ id: rec.id ?? '?', reason: 'incomplete or invalid' });
    }
  }
  return { cases, skipped };
}

export function loadEvalSet(set: EvalSet): LoadResult {
  if (set === 'tune') return parseFile('cases.tune.json', 'tune', true);
  const ai = parseFile('cases.holdout.ai.json', 'ai', true);
  const human = parseFile('cases.holdout.human.json', 'human', false);
  return { cases: [...ai.cases, ...human.cases], skipped: human.skipped };
}
