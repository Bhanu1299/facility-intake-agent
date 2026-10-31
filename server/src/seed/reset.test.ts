import request from 'supertest';
import { Asset, Budget, Site, Vendor, WorkOrder } from '@fia/shared';
import { createApp } from '../app';
import { useTestDb } from '../test/db';
import {
  addSensorReading,
  findSensorReadings,
  SensorBucketModel,
  SiteModel,
} from '../models/catalog';
import { ActivityModel } from '../models/pipeline';
import { WorkOrderModel } from '../models/workOrder';
import { ensureSeeded, resetDemoData } from './reset';

describe('demo data reset', () => {
  const { env } = useTestDb();

  it('ensureSeeded seeds an empty database once', async () => {
    expect(await ensureSeeded('propose')).toBe(true);
    expect(await ensureSeeded('propose')).toBe(false);
    expect(await SiteModel.countDocuments()).toBe(5);
  });

  it('reset wipes changes and restores the seed', async () => {
    await WorkOrderModel.deleteMany({});
    await resetDemoData('propose');
    expect(await WorkOrderModel.countDocuments()).toBe(106);
  });

  it('stores 14 days of hourly readings as per-day buckets and keeps indexes across resets', async () => {
    await resetDemoData('propose');
    const summary = await resetDemoData('propose');
    const buckets = await SensorBucketModel.find().lean();
    expect(buckets.length).toBeLessThan(summary.sensorReadings / 20);
    expect(buckets.reduce((n, b) => n + b.readings.length, 0)).toBe(summary.sensorReadings);
    const bucketIndexes = await SensorBucketModel.collection.indexes();
    expect(bucketIndexes.map((i) => i.key)).toContainEqual({ assetId: 1, day: 1 });
    const activityIndexes = await ActivityModel.collection.indexes();
    expect(activityIndexes.map((i) => i.key)).toContainEqual({ proposalId: 1, timestamp: 1 });
  });

  it('reads readings across day buckets and appends new ones in order', async () => {
    const now = new Date('2026-10-31T01:30:00Z'); // 48h back spans three UTC days
    await resetDemoData('propose', now);
    const from = new Date(now.getTime() - 48 * 3_600_000);
    const before = await findSensorReadings('elmwood-walkin-cooler', from, now);
    expect(before).toHaveLength(49);
    expect(before[0]!.readingAt.getTime()).toBeGreaterThanOrEqual(from.getTime());

    const at = new Date(now.getTime() + 60_000);
    await addSensorReading({ ...before.at(-1)!, value: 45, readingAt: at });
    const after = await findSensorReadings('elmwood-walkin-cooler', from, at);
    expect(after).toHaveLength(50);
    expect(after.at(-1)).toMatchObject({ value: 45, readingAt: at, siteId: 'elmwood' });
    const times = after.map((r) => r.readingAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it('POST /api/demo/reset reseeds and catalog endpoints return valid shapes', async () => {
    const app = createApp(env);
    const reset = await request(app).post('/api/demo/reset').expect(200);
    expect(reset.body).toMatchObject({ ok: true, sites: 5, vendors: 13 });

    const sites = await request(app).get('/api/sites').expect(200);
    expect(sites.body.map((s: unknown) => Site.parse(s).id)).toContain('elmwood');

    const assets = await request(app).get('/api/assets?siteId=hertel').expect(200);
    expect(assets.body).toHaveLength(11);
    assets.body.forEach((a: unknown) => Asset.parse(a));

    const vendors = await request(app).get('/api/vendors').expect(200);
    vendors.body.forEach((v: unknown) => Vendor.parse(v));

    const budgets = await request(app).get('/api/budgets').expect(200);
    const parsed = budgets.body.map((b: unknown) => Budget.parse(b));
    const cheek = parsed.find((b: Budget) => b.siteId === 'cheektowaga')!;
    expect(cheek.available).toBe(350);

    // Bulk inserts skip schema defaults, so every seeded work order must still be complete.
    const wos = await request(app).get('/api/work-orders').expect(200);
    expect(wos.body).toHaveLength(106);
    wos.body.forEach((w: unknown) => WorkOrder.parse(w));
    const autonomy = await request(app).get('/api/settings/autonomy').expect(200);
    expect(autonomy.body.mode).toBe('propose');
  });

  it('rate limits the reset endpoint per IP', async () => {
    const app = createApp({ ...env, DEMO_RATE_LIMIT_PER_HOUR: 1 });
    await request(app).post('/api/demo/reset').expect(200);
    const blocked = await request(app).post('/api/demo/reset').expect(429);
    expect(blocked.body.error).toMatch(/Demo limit/);
  });
});
