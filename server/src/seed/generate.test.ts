import { generateSeedData, HISTORY_COUNT, SENSOR_DAYS } from './generate';
import { REPEAT_ISSUE_ASSET_ID, TRENDING_SENSORS } from './data';

const NOW = new Date('2026-10-30T15:00:00Z');
const DAY = 86_400_000;

describe('generateSeedData', () => {
  const data = generateSeedData(NOW);
  const assetIds = new Set(data.assets.map((a) => a._id));
  const vendorIds = new Set(data.vendors.map((v) => v._id));

  it('is deterministic for the same anchor time', () => {
    const again = generateSeedData(NOW);
    expect(again.workOrders.map((w) => [w.number, w.assetId, w.actualCost])).toEqual(
      data.workOrders.map((w) => [w.number, w.assetId, w.actualCost]),
    );
  });

  it('has 5 sites with ~10 assets each, all with valid site references', () => {
    expect(data.sites).toHaveLength(5);
    for (const site of data.sites) {
      const count = data.assets.filter((a) => a.siteId === site._id).length;
      expect(count).toBeGreaterThanOrEqual(10);
    }
    expect(data.assets.every((a) => data.sites.some((s) => s._id === a.siteId))).toBe(true);
  });

  it('has ~12 vendors covering all 6 trades, 1-2 with expired insurance', () => {
    expect(data.vendors.length).toBeGreaterThanOrEqual(12);
    const trades = new Set(data.vendors.flatMap((v) => v.trades));
    expect(trades.size).toBe(6);
    const expired = data.vendors.filter((v) => v.insuranceExpiry < NOW);
    expect(expired.length).toBeGreaterThanOrEqual(1);
    expect(expired.length).toBeLessThanOrEqual(2);
  });

  it('has 100 closed work orders over ~6 months and some open ones, all well-formed', () => {
    const closed = data.workOrders.filter((w) => w.status === 'completed');
    const open = data.workOrders.filter((w) => w.status !== 'completed');
    expect(closed).toHaveLength(HISTORY_COUNT);
    expect(open.length).toBeGreaterThanOrEqual(5);
    const oldest = Math.min(...closed.map((w) => w.createdAt.getTime()));
    expect((NOW.getTime() - oldest) / DAY).toBeGreaterThan(150);
    for (const wo of data.workOrders) {
      if (wo.assetId) expect(assetIds.has(wo.assetId)).toBe(true);
      expect(vendorIds.has(wo.vendorId!)).toBe(true);
      if (wo.actualCost !== null) expect(wo.actualCost).toBeLessThanOrEqual(wo.nte);
    }
    expect(new Set(data.workOrders.map((w) => w.number)).size).toBe(data.workOrders.length);
  });

  it('only the designated asset has 3+ work orders in the last 90 days', () => {
    const counts = new Map<string, number>();
    for (const wo of data.workOrders) {
      if (!wo.assetId || NOW.getTime() - wo.createdAt.getTime() > 90 * DAY) continue;
      counts.set(wo.assetId, (counts.get(wo.assetId) ?? 0) + 1);
    }
    const repeaters = [...counts].filter(([, n]) => n >= 3).map(([id]) => id);
    expect(repeaters).toEqual([REPEAT_ISSUE_ASSET_ID]);
  });

  it('has open work orders inside and outside the 72h duplicate window', () => {
    const open = data.workOrders.filter((w) => w.status !== 'completed');
    const ages = open.map((w) => (NOW.getTime() - w.createdAt.getTime()) / 3_600_000);
    expect(ages.some((h) => h <= 72)).toBe(true);
    expect(ages.some((h) => h > 72)).toBe(true);
  });

  it('keeps Available = Total - Committed - Spent, with one site nearly out of budget', () => {
    for (const b of data.budgets) {
      const committed = data.workOrders
        .filter((w) => w.siteId === b._id && w.status !== 'completed')
        .reduce((s, w) => s + w.nte, 0);
      expect(b.committed).toBe(committed);
      expect(b.total - b.committed - b.spent).toBeGreaterThanOrEqual(0);
    }
    const low = data.budgets.filter((b) => b.total - b.committed - b.spent < 400);
    expect(low.map((b) => b._id)).toEqual(['cheektowaga']);
  });

  it('has 14 days of hourly sensor readings for coolers, freezers, AC units and water heaters', () => {
    const sensorAssets = data.assets.filter((a) => a.sensor);
    expect(sensorAssets).toHaveLength(25);
    const perAsset = data.sensorReadings.filter((r) => r.assetId === 'elmwood-walkin-cooler');
    expect(perAsset).toHaveLength(SENSOR_DAYS * 24 + 1);
  });

  it('keeps non-trending sensors inside their normal band and away from alerts', () => {
    for (const r of data.sensorReadings) {
      if (TRENDING_SENSORS[r.assetId]) continue;
      const spec = data.assets.find((a) => a._id === r.assetId)!.sensor!;
      if (spec.alertAbove !== null) expect(r.value).toBeLessThan(spec.alertAbove);
      if (spec.alertBelow !== null) expect(r.value).toBeGreaterThan(spec.alertBelow);
    }
  });

  it('has trending sensors rising toward (but not past) their threshold', () => {
    for (const assetId of Object.keys(TRENDING_SENSORS)) {
      const spec = data.assets.find((a) => a._id === assetId)!.sensor!;
      const readings = data.sensorReadings.filter((r) => r.assetId === assetId);
      const lastDay = readings.slice(-24).map((r) => r.value);
      const weekAgo = readings.slice(-24 * 8, -24 * 7).map((r) => r.value);
      const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
      expect(avg(lastDay)).toBeGreaterThan(avg(weekAgo) + 1);
      expect(Math.max(...lastDay)).toBeLessThan(spec.alertAbove!);
    }
  });
});
