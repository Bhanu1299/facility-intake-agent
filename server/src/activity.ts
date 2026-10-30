import type { ActivityStep } from '@fia/shared';
import { ActivityModel } from './models/pipeline';
import { newId } from './ids';

export interface ActivityInput {
  step: ActivityStep;
  actor: string;
  signalId?: string | null;
  proposalId?: string | null;
  workOrderId?: string | null;
  inputSummary?: string;
  outputSummary?: string;
  reason?: string | null;
  latencyMs?: number | null;
}

/** Appends one Activity Log entry. Every pipeline step and every human action calls this. */
export async function logActivity(entry: ActivityInput): Promise<void> {
  await ActivityModel.create({
    _id: newId('act'),
    timestamp: new Date(),
    signalId: entry.signalId ?? null,
    proposalId: entry.proposalId ?? null,
    workOrderId: entry.workOrderId ?? null,
    step: entry.step,
    actor: entry.actor,
    inputSummary: truncate(entry.inputSummary ?? ''),
    outputSummary: truncate(entry.outputSummary ?? ''),
    reason: entry.reason ?? null,
    latencyMs: entry.latencyMs ?? null,
  });
}

function truncate(s: string, max = 600): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
