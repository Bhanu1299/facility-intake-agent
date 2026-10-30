import { z } from 'zod';
import { Trade, Urgency, WorkOrderStatus } from './enums';

/** The fields a manager sees and can edit before approving. One shape for proposal and work order. */
export const WorkOrderDraft = z.object({
  siteId: z.string().min(1),
  assetId: z.string().nullable(),
  trade: Trade,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000),
  locationText: z.string().trim().max(300),
  urgency: Urgency,
  /** Not-to-Exceed spending limit in USD. */
  nte: z.number().nonnegative(),
  vendorId: z.string().nullable(),
});
export type WorkOrderDraft = z.infer<typeof WorkOrderDraft>;

/** Body of PATCH /api/proposals/:id and the optional body of approve. */
export const WorkOrderDraftPatch = WorkOrderDraft.omit({ siteId: true }).partial().strict();
export type WorkOrderDraftPatch = z.infer<typeof WorkOrderDraftPatch>;

export const DispatchEmail = z.object({
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  /** Always false: dispatch emails are generated for review, never actually sent. */
  sent: z.literal(false),
});
export type DispatchEmail = z.infer<typeof DispatchEmail>;

export const WorkOrder = WorkOrderDraft.extend({
  id: z.string(),
  number: z.string(),
  status: WorkOrderStatus,
  proposalId: z.string().nullable(),
  /** Free-text notes, e.g. merged duplicate reports. */
  notes: z.array(z.string()),
  dispatchEmail: DispatchEmail.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});
export type WorkOrder = z.infer<typeof WorkOrder>;
