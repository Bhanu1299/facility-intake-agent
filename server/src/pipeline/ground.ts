import type { TradeOrUnknown } from '@fia/shared';
import { OPEN_STATUSES, WorkOrderModel, type WorkOrderDoc } from '../models/workOrder';

export const DUPLICATE_WINDOW_HOURS = 72;
export const REPEAT_WINDOW_DAYS = 90;
export const REPEAT_THRESHOLD = 3;

const AREA_STOPWORDS = new Set([
  'the',
  'and',
  'near',
  'next',
  'behind',
  'area',
  'room',
  'floor',
  'side',
  'back',
  'front',
  'from',
  'inside',
  'outside',
  'upstairs',
  'downstairs',
  '1st',
  '2nd',
  'off',
  'all',
  'over',
  'mostly',
  'with',
  'this',
  'that',
  'there',
  'here',
  'serves',
  'unit',
  'north',
  'south',
]);

/** Significant words of a location description, e.g. "Bar, floor drain behind the bar" -> bar, drain. */
export function areaWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[’']s\b/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !AREA_STOPWORDS.has(w)),
  );
}

export function sameArea(a: string, b: string): boolean {
  const wa = areaWords(a);
  for (const w of areaWords(b)) if (wa.has(w)) return true;
  return false;
}

/**
 * Duplicate candidates: open work orders at the same site created in the last 72 hours with
 * the same asset, or (no asset match) the same trade in the same area.
 */
export async function findDuplicateCandidates(args: {
  siteId: string;
  assetId: string | null;
  trade: TradeOrUnknown;
  locationText: string;
  now: Date;
}): Promise<WorkOrderDoc[]> {
  const since = new Date(args.now.getTime() - DUPLICATE_WINDOW_HOURS * 3_600_000);
  const open = await WorkOrderModel.find({
    siteId: args.siteId,
    status: { $in: OPEN_STATUSES },
    createdAt: { $gte: since, $lte: args.now },
  })
    .sort({ createdAt: -1 })
    .lean();
  return open.filter((wo) => {
    if (args.assetId && wo.assetId === args.assetId) return true;
    if (args.trade === 'unknown' || wo.trade !== args.trade) return false;
    // Different specific assets are different equipment even if the area words overlap.
    if (args.assetId && wo.assetId && wo.assetId !== args.assetId) return false;
    return sameArea(args.locationText, `${wo.locationText} ${wo.title}`);
  });
}

/** Work orders on this asset in the last 90 days (any status). */
export async function recentRepairCount(assetId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - REPEAT_WINDOW_DAYS * 86_400_000);
  return WorkOrderModel.countDocuments({ assetId, createdAt: { $gte: since, $lte: now } });
}

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

export function repeatIssueNote(count: number): string | null {
  if (count < REPEAT_THRESHOLD) return null;
  return `${count} repairs on this asset in the last 90 days; this would be the ${ordinal(count + 1)} this quarter. Consider replacement.`;
}
