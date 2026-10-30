import { z } from 'zod';
import { TradeOrUnknown, Urgency } from './enums';

/**
 * Output of pipeline Step 2 (Understand). This is the only shape the model produces
 * for intake; it is also the source of the strict JSON schema sent to the provider.
 */
export const Understanding = z.object({
  trade: TradeOrUnknown,
  problemSummary: z.string().min(1),
  assetId: z.string().nullable(),
  locationText: z.string(),
  urgency: Urgency,
  urgencyReason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  clarifyingQuestion: z.string().nullable(),
});
export type Understanding = z.infer<typeof Understanding>;

/** Output of the duplicate check: a strict yes/no. */
export const DuplicateVerdict = z.object({
  sameProblem: z.boolean(),
  reason: z.string(),
});
export type DuplicateVerdict = z.infer<typeof DuplicateVerdict>;
