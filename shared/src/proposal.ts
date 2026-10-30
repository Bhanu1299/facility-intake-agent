import { z } from 'zod';
import { ProposalStatus } from './enums';
import { WorkOrderDraft } from './workOrder';

export const VendorRecommendation = z.object({
  vendorId: z.string(),
  name: z.string(),
  score: z.number().min(0).max(1),
  distanceMiles: z.number().nonnegative(),
  rating: z.number(),
  performanceScore: z.number(),
  hourlyRate: z.number(),
  /** One line, e.g. "Closest (2.1 mi), 4.8 rating, insurance valid to Mar 2027." */
  reason: z.string(),
});
export type VendorRecommendation = z.infer<typeof VendorRecommendation>;

export const SafetyRuleHit = z.object({
  ruleId: z.string(),
  label: z.string(),
  matchedText: z.string(),
});
export type SafetyRuleHit = z.infer<typeof SafetyRuleHit>;

export const BudgetCheck = z.object({
  /** NTE from the trade x urgency table, before the budget cap. */
  tableNte: z.number().nonnegative(),
  available: z.number(),
  needsBudgetIncrease: z.boolean(),
  shortfall: z.number().nonnegative(),
});
export type BudgetCheck = z.infer<typeof BudgetCheck>;

export const DuplicateInfo = z.object({
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  reason: z.string(),
  urgencyRaised: z.boolean(),
});
export type DuplicateInfo = z.infer<typeof DuplicateInfo>;

export const TokenUsage = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const Proposal = z.object({
  id: z.string(),
  signalId: z.string(),
  status: ProposalStatus,
  /** `merge` = attach this report to an existing open work order instead of creating one. */
  action: z.enum(['create', 'merge']),
  draft: WorkOrderDraft,
  urgencyReason: z.string(),
  safetyRule: SafetyRuleHit.nullable(),
  vendors: z.array(VendorRecommendation).max(3),
  budget: BudgetCheck,
  duplicate: DuplicateInfo.nullable(),
  repeatIssueNote: z.string().nullable(),
  /** Sensor signals only: "at this rate it crosses the threshold in about N days." */
  trendNote: z.string().nullable(),
  needsHuman: z.boolean(),
  needsHumanReason: z.string().nullable(),
  clarifyingQuestion: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  modelUsed: z.string().nullable(),
  escalated: z.boolean(),
  latencyMs: z.number().nonnegative(),
  usage: TokenUsage,
  workOrderId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Proposal = z.infer<typeof Proposal>;

export const RejectProposalInput = z.object({
  reason: z.string().trim().min(3).max(1000),
});
export type RejectProposalInput = z.infer<typeof RejectProposalInput>;
