import { z } from 'zod';

export const TRADES = [
  'plumbing',
  'hvac',
  'refrigeration',
  'electrical',
  'handyman',
  'pest_control',
] as const;
export const Trade = z.enum(TRADES);
export type Trade = z.infer<typeof Trade>;

export const TradeOrUnknown = z.enum([...TRADES, 'unknown']);
export type TradeOrUnknown = z.infer<typeof TradeOrUnknown>;

/** Ordered most to least urgent. */
export const URGENCIES = ['emergency', 'urgent', 'routine', 'low'] as const;
export const Urgency = z.enum(URGENCIES);
export type Urgency = z.infer<typeof Urgency>;

/** Higher number = more urgent. Used for "raise urgency" and within-one-level comparisons. */
export const URGENCY_RANK: Record<Urgency, number> = {
  low: 0,
  routine: 1,
  urgent: 2,
  emergency: 3,
};

export const WORK_ORDER_STATUSES = [
  'proposed',
  'approved',
  'dispatched',
  'accepted',
  'in_progress',
  'completed',
] as const;
export const WorkOrderStatus = z.enum(WORK_ORDER_STATUSES);
export type WorkOrderStatus = z.infer<typeof WorkOrderStatus>;

/** `advisory` = produced in Advise mode; it can be read but never approved. */
/**
 * `create` = new work order, `merge` = attach a report to an open one, `reassign` = the vendor
 * declined or missed a call; propose the next vendor for the same work order. `quotes` = quote
 * calls are done; the manager picks a vendor from the comparison.
 */
export const PROPOSAL_ACTIONS = ['create', 'merge', 'reassign', 'quotes'] as const;
export const ProposalAction = z.enum(PROPOSAL_ACTIONS);
export type ProposalAction = z.infer<typeof ProposalAction>;

export const PROPOSAL_STATUSES = ['proposed', 'approved', 'rejected', 'advisory'] as const;
export const ProposalStatus = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/** advise = Phase 1, propose = Phase 2 (default), auto = Phase 3 (stretch). */
export const AUTONOMY_MODES = ['advise', 'propose', 'auto'] as const;
export const AutonomyMode = z.enum(AUTONOMY_MODES);
export type AutonomyMode = z.infer<typeof AutonomyMode>;

export const SENSOR_METRICS = ['temperature', 'vibration'] as const;
export const SensorMetric = z.enum(SENSOR_METRICS);
export type SensorMetric = z.infer<typeof SensorMetric>;

export const SENSOR_UNITS = ['F', 'mm/s'] as const;
export const SensorUnit = z.enum(SENSOR_UNITS);
export type SensorUnit = z.infer<typeof SensorUnit>;
