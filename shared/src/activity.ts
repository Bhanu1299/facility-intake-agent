import { z } from 'zod';

export const PIPELINE_STEPS = [
  'normalize',
  'understand',
  'safety',
  'ground',
  'plan',
  'verify',
  'propose',
] as const;
export const HUMAN_ACTIONS = ['edit', 'approve', 'reject', 'settings', 'reset'] as const;
export const ActivityStep = z.enum([...PIPELINE_STEPS, ...HUMAN_ACTIONS]);
export type ActivityStep = z.infer<typeof ActivityStep>;

/** `system`, `manager`, or `model:<model name>`. */
export const ActivityActor = z.string().regex(/^(system|manager|model:.+)$/);
export type ActivityActor = z.infer<typeof ActivityActor>;

export const ActivityEntry = z.object({
  id: z.string(),
  timestamp: z.string(),
  signalId: z.string().nullable(),
  proposalId: z.string().nullable(),
  workOrderId: z.string().nullable(),
  step: ActivityStep,
  actor: ActivityActor,
  inputSummary: z.string(),
  outputSummary: z.string(),
  reason: z.string().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;
