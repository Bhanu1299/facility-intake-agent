import type { SensorSpec, Urgency } from '@fia/shared';

const DAY_MS = 86_400_000;

export interface Point {
  at: Date;
  value: number;
}

/** Least-squares slope in units per day. Null with fewer than 2 points or no time spread. */
export function slopePerDay(points: Point[]): number | null {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.at.getTime() / DAY_MS);
  const ys = points.map((p) => p.value);
  const n = points.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

export interface SensorAssessment {
  urgency: Urgency;
  urgencyReason: string;
  /** "At this rate it crosses the threshold in about N days." when a crossing is ahead. */
  trendNote: string | null;
  pastThreshold: boolean;
  /** How far past the threshold, as a fraction of the normal-to-alert margin. */
  severity: number;
  slopePerDay: number | null;
  daysToThreshold: number | null;
  /** Set when the new reading moved sharply toward the threshold versus the previous one. */
  jumpedFrom: number | null;
}

/** Window used for the rate. Older readings describe a different regime than "right now". */
export const RATE_WINDOW_HOURS = 24;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const unitText = (unit: SensorSpec['unit']): string => (unit === 'F' ? '°F' : 'mm/s');

export function formatValue(value: number, unit: SensorSpec['unit']): string {
  return `${round1(value)} ${unitText(unit)}`;
}

function formatDays(days: number): string {
  if (days < 1) return 'in under a day';
  const n = Math.round(days);
  return `in about ${n} day${n === 1 ? '' : 's'}`;
}

/**
 * Urgency from data, not the model. `reading` is the new value; `history` is recent readings
 * (it may or may not already contain the new one). The rate uses the last 24h, new reading
 * included. Rules (documented in eval/README.md):
 *   past threshold by >= 1 margin -> emergency; past threshold -> urgent;
 *   otherwise trend crosses in <= 2 days -> urgent, <= 7 days -> routine, else low.
 * A step toward the threshold of at least one margin since the previous reading is reported as
 * "jumped from X to Y" instead of a per-day rate, which would smear it out.
 */
export function assessSensor(spec: SensorSpec, reading: Point, history: Point[]): SensorAssessment {
  const { value } = reading;
  const unit = unitText(spec.unit);
  const above = spec.alertAbove !== null;
  const threshold = (above ? spec.alertAbove : spec.alertBelow) as number;
  const margin = above ? threshold - spec.normalMax : spec.normalMin - threshold;
  const pastBy = above ? value - threshold : threshold - value;
  const windowStart = reading.at.getTime() - RATE_WINDOW_HOURS * 3_600_000;
  const prior = history
    .filter((p) => p.at.getTime() >= windowStart && p.at.getTime() < reading.at.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const slope = slopePerDay([...prior, reading]);
  // Rate toward the threshold (positive = getting worse).
  const towardRate = slope === null ? null : above ? slope : -slope;
  const previous = prior.at(-1) ?? null;
  const step = previous ? (above ? value - previous.value : previous.value - value) : 0;
  const jumpedFrom = previous && step >= margin ? previous.value : null;
  const limit = `the ${formatValue(threshold, spec.unit)} limit`;
  const readingText = formatValue(value, spec.unit);
  const movement =
    jumpedFrom !== null
      ? `it ${above ? 'jumped' : 'dropped'} from ${round1(jumpedFrom)} to ${readingText} since the previous reading`
      : null;
  const ratePhrase = (digits: number): string =>
    `${above ? 'rising' : 'falling'} about ${Math.abs(towardRate!).toFixed(digits)} ${unit} per day over the last ${RATE_WINDOW_HOURS}h`;

  if (pastBy > 0) {
    const severity = pastBy / margin;
    const urgency: Urgency = severity >= 1 ? 'emergency' : 'urgent';
    const detail = movement
      ? `; ${movement}`
      : towardRate !== null && towardRate > 0
        ? `, still ${ratePhrase(1)}`
        : '';
    return {
      urgency,
      urgencyReason: `Reading ${readingText} is ${pastBy.toFixed(1)} ${unit} ${above ? 'above' : 'below'} ${limit}${detail}.`,
      trendNote: null,
      pastThreshold: true,
      severity,
      slopePerDay: slope,
      daysToThreshold: 0,
      jumpedFrom,
    };
  }

  let daysToThreshold: number | null = null;
  if (towardRate !== null && towardRate > 0) daysToThreshold = -pastBy / towardRate;

  let urgency: Urgency = 'low';
  if (daysToThreshold !== null && daysToThreshold <= 2) urgency = 'urgent';
  else if (daysToThreshold !== null && daysToThreshold <= 7) urgency = 'routine';

  const trendNote =
    daysToThreshold !== null && daysToThreshold <= 14
      ? `At this rate it crosses the threshold ${formatDays(daysToThreshold)}.`
      : null;

  const within = `Reading ${readingText} is within limits (${(-pastBy).toFixed(1)} ${unit} ${above ? 'below' : 'above'} ${limit})`;
  return {
    urgency,
    urgencyReason:
      within +
      (movement
        ? `, but ${movement}.`
        : trendNote
          ? `, but it has been ${ratePhrase(2)}.`
          : ' and is not trending toward it.'),
    trendNote,
    pastThreshold: false,
    severity: 0,
    slopePerDay: slope,
    daysToThreshold,
    jumpedFrom,
  };
}
