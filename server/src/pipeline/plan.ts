import type { BudgetCheck, Trade, Urgency, VendorRecommendation } from '@fia/shared';
import { NTE_TABLE } from '../config/nte';
import type { VendorDoc } from '../models/catalog';

/** How soon a vendor must be able to start, by urgency. */
export const URGENCY_WINDOW_HOURS: Record<Urgency, number> = {
  emergency: 4,
  urgent: 24,
  routine: 5 * 24,
  low: 14 * 24,
};

export const SCORE_WEIGHTS = { performance: 0.4, distance: 0.3, rating: 0.2, price: 0.1 };

/** All sites are in Buffalo, NY; vendor windows are local time. */
export const SITE_TIME_ZONE = 'America/New_York';

export interface NtePlan extends BudgetCheck {
  nte: number;
}

/** Table NTE (trade x urgency), capped at the site's Available budget. */
export function planNte(trade: Trade, urgency: Urgency, available: number): NtePlan {
  const tableNte = NTE_TABLE[trade][urgency];
  const safeAvailable = Math.max(0, available);
  const needsBudgetIncrease = safeAvailable < tableNte;
  return {
    tableNte,
    available,
    nte: Math.min(tableNte, safeAvailable),
    needsBudgetIncrease,
    shortfall: needsBudgetIncrease ? tableNte - safeAvailable : 0,
  };
}

export function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 3958.8;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const localFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: SITE_TIME_ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function localDayAndMinutes(date: Date): { day: number; minutes: number } {
  const parts = Object.fromEntries(localFormat.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    day: DAY_INDEX[parts.weekday ?? 'Sun'] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Earliest time at or after `from` that falls inside one of the vendor's weekly windows and
 * after any booking. Scans in 15-minute steps up to `horizonHours`; null if none.
 */
export function nextAvailableAt(
  vendor: Pick<VendorDoc, 'windows' | 'bookedUntil'>,
  from: Date,
  horizonHours = 15 * 24,
): Date | null {
  const STEP = 15 * 60_000;
  let t = Math.max(from.getTime(), vendor.bookedUntil?.getTime() ?? 0);
  // Align to the next 15-minute boundary (window checks are minute-granular).
  t = Math.ceil(t / STEP) * STEP;
  const end = from.getTime() + horizonHours * 3_600_000;
  for (; t <= end; t += STEP) {
    const { day, minutes } = localDayAndMinutes(new Date(t));
    const open = vendor.windows.some(
      (w) => w.days.includes(day) && minutes >= toMinutes(w.start) && minutes <= toMinutes(w.end),
    );
    if (open) return new Date(t);
  }
  return null;
}

export interface VendorRanking {
  top: VendorRecommendation[];
  excluded: { vendorId: string; name: string; reason: string }[];
}

const monthYear = (d: Date): string =>
  d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: SITE_TIME_ZONE });

/**
 * Fixed scales (not min-max across candidates) so a score means the same thing whether there
 * are 2 eligible vendors or 10, and the runner-up never shows as 0.
 */
export const SCORE_SCALES = { maxMiles: 30, minRate: 50, maxRate: 150 };

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function vendorScore(
  v: { performanceScore: number; rating: number; hourlyRate: number },
  miles: number,
): number {
  const { maxMiles, minRate, maxRate } = SCORE_SCALES;
  return (
    SCORE_WEIGHTS.performance * clamp01(v.performanceScore / 100) +
    SCORE_WEIGHTS.distance * clamp01(1 - miles / maxMiles) +
    SCORE_WEIGHTS.rating * clamp01(v.rating / 5) +
    SCORE_WEIGHTS.price * clamp01((maxRate - v.hourlyRate) / (maxRate - minRate))
  );
}

/** Hard filters (trade, insurance, availability window), then a weighted score. Top 3. */
export function rankVendors(
  vendors: VendorDoc[],
  site: { lat: number; lng: number },
  trade: Trade,
  urgency: Urgency,
  now: Date,
): VendorRanking {
  const excluded: VendorRanking['excluded'] = [];
  const windowHours = URGENCY_WINDOW_HOURS[urgency];
  const eligible: { v: VendorDoc; miles: number; availableAt: Date }[] = [];

  for (const v of vendors) {
    if (!v.trades.includes(trade)) continue; // other trades aren't "excluded", just irrelevant
    if (v.insuranceExpiry <= now) {
      excluded.push({
        vendorId: v._id,
        name: v.name,
        reason: `Insurance expired ${v.insuranceExpiry.toISOString().slice(0, 10)}`,
      });
      continue;
    }
    const availableAt = nextAvailableAt(v, now, windowHours);
    if (!availableAt) {
      excluded.push({
        vendorId: v._id,
        name: v.name,
        reason: `Not available within ${windowHours < 48 ? `${windowHours}h` : `${windowHours / 24} days`} (${urgency})`,
      });
      continue;
    }
    eligible.push({ v, miles: haversineMiles(site, v), availableAt });
  }

  const range = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
  const perfR = range(eligible.map((e) => e.v.performanceScore));
  const distR = range(eligible.map((e) => e.miles));
  const priceR = range(eligible.map((e) => e.v.hourlyRate));

  const scored = eligible
    .map((e) => ({
      ...e,
      score: vendorScore(e.v, e.miles),
    }))
    .sort((a, b) => b.score - a.score || a.miles - b.miles);

  const top = scored.slice(0, 3).map((e): VendorRecommendation => {
    const miles = Math.round(e.miles * 10) / 10;
    const parts: string[] = [];
    parts.push(
      e.miles === distR[0] && eligible.length > 1 ? `Closest (${miles} mi)` : `${miles} mi away`,
    );
    parts.push(`${e.v.rating.toFixed(1)} rating`);
    if (e.v.performanceScore === perfR[1] && eligible.length > 1) {
      parts.push(`top performance score (${e.v.performanceScore})`);
    }
    if (e.v.hourlyRate === priceR[0] && eligible.length > 1)
      parts.push(`lowest rate ($${e.v.hourlyRate}/hr)`);
    if (e.availableAt.getTime() - now.getTime() > 60 * 60_000) {
      parts.push(
        `earliest start ${e.availableAt.toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: SITE_TIME_ZONE,
        })}`,
      );
    }
    parts.push(`insurance valid to ${monthYear(e.v.insuranceExpiry)}`);
    return {
      vendorId: e.v._id,
      name: e.v.name,
      score: Math.round(e.score * 1000) / 1000,
      distanceMiles: miles,
      rating: e.v.rating,
      performanceScore: e.v.performanceScore,
      hourlyRate: e.v.hourlyRate,
      reason: `${parts.join(', ')}.`,
    };
  });

  return { top, excluded };
}
