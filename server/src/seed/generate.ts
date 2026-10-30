import type { AssetDoc, BudgetDoc, SensorReadingDoc, SiteDoc, VendorDoc } from '../models/catalog';
import type { WorkOrderDoc } from '../models/workOrder';
import { NTE_TABLE } from '../config/nte';
import {
  ASSET_TEMPLATES,
  COMPANY_NAME,
  HISTORY_TEMPLATES,
  OPEN_WORK_ORDERS,
  REPEAT_ISSUE_ASSET_ID,
  SENSOR_SPECS,
  SITES,
  TRENDING_SENSORS,
  VENDORS,
} from './data';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const HISTORY_COUNT = 100;
export const HISTORY_DAYS = 180;
export const SENSOR_DAYS = 14;
const REPEAT_WINDOW_DAYS = 90;
const FIRST_WO_NUMBER = 1001;

export interface SeedData {
  sites: SiteDoc[];
  assets: AssetDoc[];
  vendors: VendorDoc[];
  budgets: BudgetDoc[];
  workOrders: WorkOrderDoc[];
  sensorReadings: SensorReadingDoc[];
  nextWorkOrderSeq: number;
}

/** Small deterministic PRNG so every reset produces the same demo (anchored to `now`). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the full demo dataset. Pure: all dates are relative to `now`, so the 72h duplicate
 * window and 90-day repeat window always line up with "today".
 */
export function generateSeedData(now: Date = new Date(), seed = 42): SeedData {
  const rand = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const between = (min: number, max: number): number => min + rand() * (max - min);
  const t = now.getTime();

  const sites: SiteDoc[] = SITES.map((s) => ({
    _id: s.id,
    name: `${COMPANY_NAME} – ${s.shortName}`,
    shortName: s.shortName,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    hours: s.hours,
  }));

  const assets: AssetDoc[] = SITES.flatMap((site) =>
    ASSET_TEMPLATES.map((tpl) => ({
      _id: `${site.id}-${tpl.key}`,
      siteId: site.id,
      name: tpl.name,
      type: tpl.type,
      trade: tpl.trade,
      location: tpl.location(site),
      installYear: 2012 + Math.floor(rand() * 12),
      sensor: SENSOR_SPECS[tpl.type] ?? null,
    })),
  );
  const assetById = new Map(assets.map((a) => [a._id, a]));

  const vendors: VendorDoc[] = VENDORS.map((v) => ({
    _id: v.id,
    name: v.name,
    trades: v.trades,
    lat: v.lat,
    lng: v.lng,
    rating: v.rating,
    performanceScore: v.performanceScore,
    hourlyRate: v.hourlyRate,
    email: `dispatch@${v.id.replace(/^v-/, '')}.example`,
    phone: v.phone,
    insuranceExpiry: new Date(t + v.insuranceDays * DAY),
    emergency24x7: v.emergency24x7,
    windows: v.windows,
    bookedUntil: v.bookedHours > 0 ? new Date(t + v.bookedHours * HOUR) : null,
  }));
  const vendorsForTrade = (trade: string): VendorDoc[] =>
    vendors.filter((v) => v.trades.includes(trade as VendorDoc['trades'][number]));

  // --- Work orders -------------------------------------------------------------------------
  type Draft = Omit<WorkOrderDoc, 'number'>;
  const drafts: Draft[] = [];
  let idCounter = 0;
  const newId = (): string => `wo-seed-${String(++idCounter).padStart(3, '0')}`;
  const recentCount = new Map<string, number>(); // asset -> work orders in last 90 days

  const bumpRecent = (assetId: string | null, createdAt: Date): void => {
    if (!assetId || t - createdAt.getTime() > REPEAT_WINDOW_DAYS * DAY) return;
    recentCount.set(assetId, (recentCount.get(assetId) ?? 0) + 1);
  };

  for (const def of OPEN_WORK_ORDERS) {
    const createdAt = new Date(t - def.hoursAgo * HOUR);
    const assetId = def.assetKey ? `${def.siteId}-${def.assetKey}` : null;
    drafts.push({
      _id: newId(),
      siteId: def.siteId,
      assetId,
      trade: def.trade,
      title: def.title,
      description: def.description,
      locationText: def.locationText,
      urgency: def.urgency,
      nte: NTE_TABLE[def.trade][def.urgency],
      vendorId: def.vendorId,
      status: 'dispatched',
      proposalId: null,
      notes: [],
      dispatchEmail: null,
      actualCost: null,
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
    });
    bumpRecent(assetId, createdAt);
  }

  const closedWorkOrder = (asset: AssetDoc, daysAgo: number): Draft => {
    const tpl = pick(HISTORY_TEMPLATES[asset.type]);
    const createdAt = new Date(t - daysAgo * DAY - Math.floor(rand() * 10) * HOUR);
    const closedAt = new Date(createdAt.getTime() + between(4, 96) * HOUR);
    const cost = Math.round(between(tpl.cost[0], tpl.cost[1]) / 5) * 5;
    const vendor = pick(vendorsForTrade(asset.trade));
    return {
      _id: newId(),
      siteId: asset.siteId,
      assetId: asset._id,
      trade: asset.trade,
      title: tpl.title,
      description: tpl.description,
      locationText: asset.location,
      urgency: tpl.urgency,
      nte: NTE_TABLE[asset.trade][tpl.urgency],
      vendorId: vendor._id,
      status: 'completed',
      proposalId: null,
      notes: [],
      dispatchEmail: null,
      actualCost: Math.min(cost, NTE_TABLE[asset.trade][tpl.urgency]),
      createdAt,
      updatedAt: closedAt,
      closedAt,
    };
  };

  // The repeat-issue asset: 3 repairs in the last 90 days.
  const repeatAsset = assetById.get(REPEAT_ISSUE_ASSET_ID)!;
  for (const daysAgo of [78, 41, 12]) {
    const wo = closedWorkOrder(repeatAsset, daysAgo);
    drafts.push(wo);
    bumpRecent(wo.assetId, wo.createdAt);
  }

  // Everything else: random, but no other asset may reach 3 in 90 days.
  const others = assets.filter((a) => a._id !== REPEAT_ISSUE_ASSET_ID);
  let closedCount = 3;
  while (closedCount < HISTORY_COUNT) {
    const asset = pick(others);
    const daysAgo = between(3, HISTORY_DAYS);
    if (daysAgo <= REPEAT_WINDOW_DAYS && (recentCount.get(asset._id) ?? 0) >= 2) continue;
    const wo = closedWorkOrder(asset, daysAgo);
    drafts.push(wo);
    bumpRecent(wo.assetId, wo.createdAt);
    closedCount++;
  }

  drafts.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const workOrders: WorkOrderDoc[] = drafts.map((d, i) => ({
    ...d,
    number: `WO-${FIRST_WO_NUMBER + i}`,
  }));

  // --- Budgets: Committed = open NTEs; Spent covers reactive history plus contracted PM spend.
  const budgets: BudgetDoc[] = SITES.map((site) => {
    const siteWos = workOrders.filter((w) => w.siteId === site.id);
    const committed = siteWos
      .filter((w) => w.status !== 'completed')
      .reduce((sum, w) => sum + w.nte, 0);
    const historySpend = siteWos.reduce((sum, w) => sum + (w.actualCost ?? 0), 0);
    const spent = site.budgetTotal - committed - site.targetAvailable;
    if (spent < historySpend) {
      throw new Error(`Seed budget for ${site.id} is too small for its work order history.`);
    }
    return {
      _id: site.id,
      label: `${now.getFullYear()} maintenance budget`,
      total: site.budgetTotal,
      committed,
      spent,
    };
  });

  // --- Sensor history: hourly readings for 14 days ------------------------------------------
  const sensorReadings: SensorReadingDoc[] = [];
  const noise = (scale: number): number => (rand() + rand() + rand() - 1.5) * scale;
  for (const asset of assets) {
    const spec = asset.sensor;
    if (!spec) continue;
    const mid = (spec.normalMin + spec.normalMax) / 2;
    const trend = TRENDING_SENSORS[asset._id];
    const scale = spec.metric === 'vibration' ? 0.35 : asset.type === 'water_heater' ? 2 : 0.5;
    const baseline = trend ? trend.from : spec.metric === 'vibration' ? 3 : mid;
    for (let h = SENSOR_DAYS * 24; h >= 0; h--) {
      const at = t - h * HOUR;
      let value = baseline;
      if (trend) {
        const daysFromEnd = h / 24;
        if (daysFromEnd < trend.overDays) {
          value = trend.from + (trend.to - trend.from) * (1 - daysFromEnd / trend.overDays);
        }
      }
      value += noise(trend ? scale * 0.4 : scale);
      sensorReadings.push({
        assetId: asset._id,
        siteId: asset.siteId,
        metric: spec.metric,
        unit: spec.unit,
        value: Math.round(value * 10) / 10,
        readingAt: new Date(at),
      });
    }
  }

  return {
    sites,
    assets,
    vendors,
    budgets,
    workOrders,
    sensorReadings,
    nextWorkOrderSeq: FIRST_WO_NUMBER + workOrders.length - 1,
  };
}
