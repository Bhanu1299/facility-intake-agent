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
}

export function formatValue(value: number, unit: SensorSpec['unit']): string {
  return unit === 'F' ? `${value}°F` : `${value} mm/s`;
}

function formatDays(days: number): string {
  if (days < 1) return 'in under a day';
  const n = Math.round(days);
  return `in about ${n} day${n === 1 ? '' : 's'}`;
}

/**
 * Urgency from data, not the model. `history` should be recent readings (e.g. last 48h)
 * including the new one. Rules (documented in eval/README.md):
 *   past threshold by >= 1 margin -> emergency; past threshold -> urgent;
 *   otherwise trend crosses in <= 2 days -> urgent, <= 7 days -> routine, else low.
 */
export function assessSensor(spec: SensorSpec, value: number, history: Point[]): SensorAssessment {
  const above = spec.alertAbove !== null;
  const threshold = (above ? spec.alertAbove : spec.alertBelow) as number;
  const margin = above ? threshold - spec.normalMax : spec.normalMin - threshold;
  const pastBy = above ? value - threshold : threshold - value;
  const slope = slopePerDay(history);
  // Rate toward the threshold (positive = getting worse).
  const towardRate = slope === null ? null : above ? slope : -slope;
  const thresholdText = `${above ? 'alert above' : 'alert below'} ${formatValue(threshold, spec.unit)}`;
  const reading = formatValue(value, spec.unit);

  if (pastBy > 0) {
    const severity = pastBy / margin;
    const urgency: Urgency = severity >= 1 ? 'emergency' : 'urgent';
    const rising =
      towardRate !== null && towardRate > 0
        ? ` and still getting worse by about ${Math.abs(towardRate).toFixed(1)} ${spec.unit === 'F' ? '°F' : 'mm/s'} per day`
        : '';
    return {
      urgency,
      urgencyReason: `Reading ${reading} is past the threshold (${thresholdText}) by ${Math.abs(pastBy).toFixed(1)}${rising}.`,
      trendNote: null,
      pastThreshold: true,
      severity,
      slopePerDay: slope,
      daysToThreshold: 0,
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

  return {
    urgency,
    urgencyReason:
      `Reading ${reading} is within limits (${thresholdText})` +
      (trendNote
        ? `, but it has been moving toward the threshold by about ${Math.abs(towardRate!).toFixed(2)} ${spec.unit === 'F' ? '°F' : 'mm/s'} per day.`
        : ' and is not trending toward it.'),
    trendNote,
    pastThreshold: false,
    severity: 0,
    slopePerDay: slope,
    daysToThreshold,
  };
}
