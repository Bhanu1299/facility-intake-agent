import type { Trade, Urgency } from '@fia/shared';

/**
 * Default Not-to-Exceed (USD) by trade and urgency. Edit here to change NTE policy.
 * The planner caps this at the site's Available budget.
 */
export const NTE_TABLE: Record<Trade, Record<Urgency, number>> = {
  plumbing: { low: 150, routine: 250, urgent: 400, emergency: 750 },
  hvac: { low: 200, routine: 350, urgent: 600, emergency: 1200 },
  refrigeration: { low: 200, routine: 400, urgent: 700, emergency: 1500 },
  electrical: { low: 150, routine: 300, urgent: 500, emergency: 900 },
  handyman: { low: 100, routine: 150, urgent: 250, emergency: 400 },
  pest_control: { low: 100, routine: 200, urgent: 300, emergency: 500 },
};
