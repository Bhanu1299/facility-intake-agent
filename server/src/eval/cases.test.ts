import { generateSeedData } from '../seed/generate';
import { EVAL_CATEGORIES, loadEvalSet } from './cases';

// Only the tune set is inspected here. Holdout files are never opened by tests.
describe('tune eval set', () => {
  const { cases } = loadEvalSet('tune');
  const seed = generateSeedData(new Date());
  const assets = new Map(seed.assets.map((a) => [a._id, a]));
  const openIds = new Set(
    seed.workOrders.filter((w) => w.status !== 'completed').map((w) => w._id),
  );

  it('has 40 cases with unique ids and the planned category mix', () => {
    expect(cases).toHaveLength(40);
    expect(new Set(cases.map((c) => c.id)).size).toBe(40);
    const counts = Object.fromEntries(
      EVAL_CATEGORIES.map((cat) => [cat, cases.filter((c) => c.category === cat).length]),
    );
    expect(counts).toEqual({
      easy: 10,
      messy: 10,
      emergency: 5,
      duplicate: 5,
      sensor: 4,
      needs_human: 4,
      spanish: 2,
    });
  });

  it('references real sites, assets and open work orders', () => {
    for (const c of cases) {
      const siteId =
        c.input.type === 'request' ? c.input.siteId : assets.get(c.input.assetId)?.siteId;
      expect(seed.sites.some((s) => s._id === siteId)).toBe(true);
      if (c.expected.assetId) {
        expect(assets.get(c.expected.assetId)?.siteId).toBe(siteId);
      }
      if (c.expected.duplicateOf) expect(openIds.has(c.expected.duplicateOf)).toBe(true);
    }
  });

  it('labels sensor cases with the asset trade and every emergency case as emergency', () => {
    for (const c of cases) {
      if (c.input.type === 'sensor') {
        expect(c.expected.assetId).toBe(c.input.assetId);
        expect(c.expected.trade).toBe(assets.get(c.input.assetId)!.trade);
      }
      if (c.expected.safetyEmergency) expect(c.expected.urgency).toBe('emergency');
    }
  });

  it('includes the required needsHuman case from the spec', () => {
    const c = cases.find(
      (x) => x.input.type === 'request' && /thing in the back/.test(x.input.text),
    );
    expect(c?.expected.needsHuman).toBe(true);
  });
});
