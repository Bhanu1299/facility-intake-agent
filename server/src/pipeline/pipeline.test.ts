import request from 'supertest';
import { Proposal, type SignalInput } from '@fia/shared';
import { createApp } from '../app';
import { ActivityModel, ProposalModel } from '../models/pipeline';
import { SettingsModel } from '../models/settings';
import { resetDemoData } from '../seed/reset';
import { VENDORS } from '../seed/data';
import { FakeLlm, modelDown, understanding } from '../test/fakeLlm';
import { useTestDb } from '../test/db';
import { createSignal, runPipeline, type PipelineDeps } from './pipeline';
import { findDuplicateCandidates } from './ground';

const MODELS = { small: 'small-model', big: 'big-model' };

describe('pipeline', () => {
  useTestDb();
  let now: Date;

  beforeEach(async () => {
    now = new Date();
    await resetDemoData('propose', now);
  });

  async function run(input: SignalInput, llm: FakeLlm) {
    const deps: PipelineDeps = { llm, models: MODELS, now: () => now };
    const signalId = await createSignal(input, now);
    const doc = await runPipeline(signalId, deps);
    return Proposal.parse(JSON.parse(JSON.stringify(doc)));
  }

  it('happy path: one small-model call, top 3 vendors, NTE from table, full activity log', async () => {
    const llm = new FakeLlm(() =>
      understanding({
        trade: 'plumbing',
        assetId: 'elmwood-restroom-womens',
        problemSummary: "Dripping faucet in women's restroom",
        urgency: 'low',
      }),
    );
    const p = await run(
      { type: 'request', siteId: 'elmwood', text: "The women's restroom sink faucet is dripping" },
      llm,
    );
    expect(p.status).toBe('proposed');
    expect(p.action).toBe('create');
    expect(p.escalated).toBe(false);
    expect(p.modelUsed).toBe('small-model');
    expect(p.needsHuman).toBe(false);
    expect(p.draft).toMatchObject({ trade: 'plumbing', urgency: 'low', nte: 150 });
    expect(p.vendors.length).toBeGreaterThanOrEqual(2);
    expect(p.draft.vendorId).toBe(p.vendors[0]!.vendorId);
    expect(p.checks.every((c) => c.passed)).toBe(true);
    expect(llm.calls).toHaveLength(1);

    const steps = (
      await ActivityModel.find({ proposalId: p.id }).sort({ timestamp: 1 }).lean()
    ).map((a) => a.step);
    for (const step of [
      'normalize',
      'understand',
      'safety',
      'ground',
      'plan',
      'verify',
      'propose',
    ]) {
      expect(steps).toContain(step);
    }
  });

  it('safety rule forces emergency even when the model says routine', async () => {
    const llm = new FakeLlm(() =>
      understanding({ trade: 'plumbing', assetId: 'elmwood-water-heater', urgency: 'routine' }),
    );
    const p = await run(
      { type: 'request', siteId: 'elmwood', text: 'It smells like gas by the water heater' },
      llm,
    );
    expect(p.draft.urgency).toBe('emergency');
    expect(p.safetyRule?.ruleId).toBe('gas_smell');
    expect(p.draft.nte).toBe(750);
  });

  it('escalates to the big model when confidence is low and records which model answered', async () => {
    const llm = new FakeLlm((req) =>
      req.model === 'small-model'
        ? understanding({ trade: 'refrigeration', assetId: 'elmwood-ice-machine', confidence: 0.5 })
        : understanding({
            trade: 'refrigeration',
            assetId: 'elmwood-ice-machine',
            confidence: 0.92,
          }),
    );
    const p = await run({ type: 'request', siteId: 'elmwood', text: 'ice thing slow' }, llm);
    expect(p.escalated).toBe(true);
    expect(p.modelUsed).toBe('big-model');
    expect(p.needsHuman).toBe(false);
    expect(llm.calls.map((c) => c.model)).toEqual(['small-model', 'big-model']);
  });

  it('marks needsHuman with the clarifying question instead of guessing', async () => {
    const llm = new FakeLlm(() =>
      understanding({
        trade: 'unknown',
        assetId: null,
        confidence: 0.3,
        clarifyingQuestion: 'Which equipment is making the noise?',
      }),
    );
    const p = await run(
      {
        type: 'request',
        siteId: 'hertel',
        text: 'the thing in the back is making a weird noise again',
      },
      llm,
    );
    expect(p.escalated).toBe(true);
    expect(p.needsHuman).toBe(true);
    expect(p.clarifyingQuestion).toBe('Which equipment is making the noise?');
    expect(p.needsHumanReason).toMatch(/Low confidence/);
    expect(p.needsHumanReason).toMatch(/what is broken/);
    expect(p.vendors).toEqual([]);
  });

  it('treats an asset id that is not at the site as unresolved and escalates', async () => {
    const llm = new FakeLlm((req) =>
      req.model === 'small-model'
        ? understanding({ trade: 'plumbing', assetId: 'canalside-dishwasher' }) // wrong site
        : understanding({ trade: 'plumbing', assetId: 'elmwood-dishwasher' }),
    );
    const p = await run({ type: 'request', siteId: 'elmwood', text: 'dishwasher leaking' }, llm);
    expect(p.escalated).toBe(true);
    expect(p.draft.assetId).toBe('elmwood-dishwasher');
    expect(p.needsHuman).toBe(false);
  });

  it('proposes a merge for a duplicate and raises urgency when the new report is worse', async () => {
    const llm = new FakeLlm(
      () =>
        understanding({
          trade: 'plumbing',
          assetId: 'elmwood-restroom-mens',
          urgency: 'urgent',
          locationText: "2nd floor men's restroom",
        }),
      () => ({ sameProblem: true, reason: 'Same running toilet, now overflowing.' }),
    );
    const p = await run(
      {
        type: 'request',
        siteId: 'elmwood',
        text: "upstairs men's room toilet that was running is now overflowing",
      },
      llm,
    );
    expect(p.action).toBe('merge');
    expect(p.duplicate).toMatchObject({ workOrderId: 'wo-seed-001', urgencyRaised: true });
    expect(p.draft.vendorId).toBe('v-lakeshore-plumbing'); // keeps the vendor on the job
  });

  it('does not merge when the model says it is a different problem', async () => {
    const llm = new FakeLlm(() =>
      understanding({ trade: 'plumbing', assetId: 'elmwood-restroom-mens' }),
    );
    const p = await run(
      {
        type: 'request',
        siteId: 'elmwood',
        text: "sink in the 2nd floor men's room won't shut off",
      },
      llm,
    );
    expect(p.action).toBe('create');
    expect(p.duplicate).toBeNull();
    expect(llm.calls.filter((c) => c.schemaName === 'duplicate_verdict')).toHaveLength(1);
  });

  it('adds the repeat-issue note for an asset with 3+ repairs in 90 days', async () => {
    const llm = new FakeLlm(() =>
      understanding({ trade: 'refrigeration', assetId: 'hertel-ice-machine' }),
    );
    const p = await run(
      { type: 'request', siteId: 'hertel', text: 'ice machine not making ice' },
      llm,
    );
    expect(p.repeatIssueNote).toBe(
      '3 repairs on this asset in the last 90 days; this would be the 4th this quarter. Consider replacement.',
    );
  });

  it('caps NTE at Available and flags the budget shortfall', async () => {
    const llm = new FakeLlm(() =>
      understanding({ trade: 'hvac', assetId: 'cheektowaga-rtu-1', urgency: 'urgent' }),
    );
    const p = await run(
      { type: 'request', siteId: 'cheektowaga', text: 'AC unit 1 not cooling' },
      llm,
    );
    expect(p.draft.nte).toBe(350);
    expect(p.budget).toEqual({
      tableNte: 600,
      available: 350,
      needsBudgetIncrease: true,
      shortfall: 250,
    });
    expect(p.needsHuman).toBe(false);
  });

  it('sensor: urgency, asset and trade come from data, not the model', async () => {
    const llm = new FakeLlm(() =>
      understanding({ trade: 'plumbing', assetId: null, urgency: 'low', confidence: 0.4 }),
    );
    const p = await run(
      {
        type: 'sensor',
        assetId: 'amherst-walkin-cooler',
        metric: 'temperature',
        value: 40.4,
        unit: 'F',
      },
      llm,
    );
    expect(p.signalType).toBe('sensor');
    expect(p.draft).toMatchObject({
      trade: 'refrigeration',
      assetId: 'amherst-walkin-cooler',
      urgency: 'urgent',
    });
    expect(p.trendNote).toMatch(
      /^At this rate it crosses the threshold (in under a day|in about \d+ days?)\.$/,
    );
    expect(p.escalated).toBe(false);
    expect(p.inputText).toMatch(/40.4 °F/);
  });

  it('sensor still produces a proposal when the model is down', async () => {
    const p = await run(
      {
        type: 'sensor',
        assetId: 'hertel-walkin-freezer',
        metric: 'temperature',
        value: 12,
        unit: 'F',
      },
      new FakeLlm(modelDown),
    );
    expect(p.draft.urgency).toBe('emergency');
    expect(p.modelUsed).toBe('rules');
    expect(p.needsHuman).toBe(false);
  });

  it('request with the model down becomes needsHuman, never a guess', async () => {
    const p = await run(
      { type: 'request', siteId: 'elmwood', text: 'toilet clogged' },
      new FakeLlm(modelDown),
    );
    expect(p.needsHuman).toBe(true);
    expect(p.needsHumanReason).toMatch(/could not read/);
    expect(p.modelUsed).toBeNull();
    expect(p.draft.trade).toBe('unknown');
  });

  it('privacy: the model never sees budgets, vendor names, prices or history', async () => {
    const llm = new FakeLlm(
      () => understanding({ trade: 'plumbing', assetId: 'elmwood-restroom-mens' }),
      () => ({ sameProblem: true, reason: 'same' }),
    );
    await run({ type: 'request', siteId: 'elmwood', text: 'mens toilet still running' }, llm);
    const seen = llm.calls.map((c) => `${c.system}\n${c.user}`).join('\n');
    expect(seen).not.toMatch(/\$\d/);
    expect(seen).not.toMatch(/budget|available|committed|hourly|rating|insurance/i);
    for (const v of VENDORS) expect(seen).not.toContain(v.name);
    expect(seen).not.toMatch(/WO-\d+/);
  });

  it('in advise mode, proposals are advisory', async () => {
    await SettingsModel.updateOne({ _id: 'global' }, { autonomyMode: 'advise' });
    const p = await run(
      { type: 'request', siteId: 'elmwood', text: 'toilet clogged' },
      new FakeLlm(() => understanding({ assetId: 'elmwood-restroom-mens' })),
    );
    expect(p.status).toBe('advisory');
  });
});

describe('duplicate candidates', () => {
  useTestDb();
  const now = new Date();
  beforeAll(() => resetDemoData('propose', now));

  it('matches same asset within 72h', async () => {
    const c = await findDuplicateCandidates({
      siteId: 'elmwood',
      assetId: 'elmwood-restroom-mens',
      trade: 'plumbing',
      locationText: '',
      now,
    });
    expect(c.map((w) => w._id)).toEqual(['wo-seed-001']);
  });

  it('matches same area + trade when there is no asset', async () => {
    const c = await findDuplicateCandidates({
      siteId: 'elmwood',
      assetId: null,
      trade: 'pest_control',
      locationText: 'Bar, near the drain',
      now,
    });
    expect(c.map((w) => w._id)).toEqual(['wo-seed-005']);
  });

  it('ignores work orders older than 72h, other sites and other trades', async () => {
    const old = await findDuplicateCandidates({
      siteId: 'cheektowaga',
      assetId: 'cheektowaga-walkin-cooler',
      trade: 'refrigeration',
      locationText: 'Back of kitchen',
      now,
    });
    expect(old).toEqual([]);
    const otherTrade = await findDuplicateCandidates({
      siteId: 'elmwood',
      assetId: null,
      trade: 'electrical',
      locationText: 'bar',
      now,
    });
    expect(otherTrade).toEqual([]);
  });
});

describe('signals API', () => {
  const { env } = useTestDb();
  beforeEach(() => resetDemoData('propose'));

  it('accepts a request with 202, processes it in the background, and lists the proposal', async () => {
    const llm = new FakeLlm(() => understanding({ assetId: 'canalside-restroom-womens' }));
    const app = createApp(env, { llm });
    const res = await request(app)
      .post('/api/signals')
      .send({ type: 'request', siteId: 'canalside', text: 'womens toilet clogged' })
      .expect(202);
    expect(res.body.status).toBe('processing');
    expect(res.body.safetyRuleId).toBeNull();
    await app.locals.pipelines.idle();

    const signal = await request(app).get(`/api/signals/${res.body.signalId}`).expect(200);
    expect(signal.body.status).toBe('done');
    const list = await request(app).get('/api/proposals?status=proposed').expect(200);
    expect(list.body).toHaveLength(1);
    const one = await request(app).get(`/api/proposals/${signal.body.proposalId}`).expect(200);
    expect(Proposal.parse(one.body).signalId).toBe(res.body.signalId);
    const log = await request(app).get(`/api/activity?proposalId=${one.body.id}`).expect(200);
    expect(log.body.length).toBeGreaterThanOrEqual(7);
  });

  it('returns the safety rule with the 202 so the requester gets guidance at once', async () => {
    const app = createApp(env, { llm: new FakeLlm(() => understanding({})) });
    const res = await request(app)
      .post('/api/signals')
      .send({ type: 'request', siteId: 'elmwood', text: 'it smells like gas in the kitchen' })
      .expect(202);
    expect(res.body.safetyRuleId).toBe('gas_smell');
    await app.locals.pipelines.idle();
  });

  it('rejects invalid bodies and unknown sites/assets with 400', async () => {
    const app = createApp(env, { llm: new FakeLlm(() => understanding({})) });
    await request(app)
      .post('/api/signals')
      .send({ type: 'request', siteId: 'elmwood' })
      .expect(400);
    await request(app)
      .post('/api/signals')
      .send({ type: 'request', siteId: 'nowhere', text: 'help me' })
      .expect(400);
    await request(app)
      .post('/api/demo/sensor')
      .send({ assetId: 'elmwood-fryer', metric: 'temperature', value: 400, unit: 'F' })
      .expect(400);
    expect(await ProposalModel.countDocuments()).toBe(0);
  });

  it('demo sensor endpoint runs the same pipeline', async () => {
    const app = createApp(env, { llm: new FakeLlm(() => understanding({})) });
    await request(app)
      .post('/api/demo/sensor')
      .send({ assetId: 'elmwood-walkin-cooler', metric: 'temperature', value: 42.5, unit: 'F' })
      .expect(202);
    await app.locals.pipelines.idle();
    const [p] = await ProposalModel.find().lean();
    expect(p?.draft.urgency).toBe('urgent');
  });

  it('rate limits POST /api/signals per IP', async () => {
    const app = createApp(
      { ...env, DEMO_RATE_LIMIT_PER_HOUR: 2 },
      { llm: new FakeLlm(() => understanding({})) },
    );
    const body = { type: 'request', siteId: 'elmwood', text: 'toilet clogged' };
    await request(app).post('/api/signals').send(body).expect(202);
    await request(app).post('/api/signals').send(body).expect(202);
    await request(app).post('/api/signals').send(body).expect(429);
    await app.locals.pipelines.idle();
  });
});
