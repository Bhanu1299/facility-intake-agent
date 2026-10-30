import request from 'supertest';
import { Asset, Budget, Site, Vendor } from '@fia/shared';
import { createApp } from '../app';
import { useTestDb } from '../test/db';
import { SiteModel } from '../models/catalog';
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
  });

  it('rate limits the reset endpoint per IP', async () => {
    const app = createApp({ ...env, DEMO_RATE_LIMIT_PER_HOUR: 1 });
    await request(app).post('/api/demo/reset').expect(200);
    const blocked = await request(app).post('/api/demo/reset').expect(429);
    expect(blocked.body.error).toMatch(/Demo limit/);
  });
});
