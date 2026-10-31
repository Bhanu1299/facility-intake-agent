import request from 'supertest';
import type { SignalInput, Understanding } from '@fia/shared';
import { createApp } from '../app';
import { BudgetModel } from '../models/catalog';
import { ActivityModel, ProposalModel } from '../models/pipeline';
import { WorkOrderModel } from '../models/workOrder';
import { createSignal, runPipeline } from '../pipeline/pipeline';
import { resetDemoData } from '../seed/reset';
import { FakeLlm, understanding } from '../test/fakeLlm';
import { useTestDb } from '../test/db';
import { canTransition, TRANSITIONS } from './lifecycle';

describe('approval gate', () => {
  const { env } = useTestDb();
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await resetDemoData('propose');
    app = createApp(env, { llm: new FakeLlm(() => understanding({})) });
  });

  async function propose(
    input: SignalInput,
    u: Partial<Understanding>,
    dup = false,
  ): Promise<string> {
    const llm = new FakeLlm(
      () => understanding(u),
      () => ({ sameProblem: dup, reason: dup ? 'Same problem.' : 'Different.' }),
    );
    const { id: signalId } = await createSignal(input);
    const p = await runPipeline(signalId, { llm, models: { small: 's', big: 'b' } });
    return p._id;
  }

  const available = async (siteId: string): Promise<number> => {
    const b = (await BudgetModel.findById(siteId).lean())!;
    return b.total - b.committed - b.spent;
  };

  const faucet = (): Promise<string> =>
    propose(
      { type: 'request', siteId: 'elmwood', text: "women's restroom faucet dripping" },
      {
        trade: 'plumbing',
        assetId: 'elmwood-restroom-womens',
        urgency: 'low',
        problemSummary: 'Dripping faucet',
      },
    );

  it('nothing but the proposal and log change before approval', async () => {
    const wos = await WorkOrderModel.countDocuments();
    const before = await available('elmwood');
    await faucet();
    expect(await WorkOrderModel.countDocuments()).toBe(wos);
    expect(await available('elmwood')).toBe(before);
  });

  it('approve creates the work order, commits NTE, dispatches with a drafted (unsent) email', async () => {
    const id = await faucet();
    const before = await available('elmwood');
    const res = await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(201);
    expect(res.body.created).toBe(true);
    expect(res.body.proposal.status).toBe('approved');
    const wo = res.body.workOrder;
    expect(wo).toMatchObject({ status: 'dispatched', nte: 150, trade: 'plumbing', proposalId: id });
    expect(wo.number).toMatch(/^WO-\d+$/);
    expect(wo.dispatchEmail.sent).toBe(false);
    expect(wo.dispatchEmail.to).toMatch(/@.+\.example$/);
    expect(wo.dispatchEmail.body).toContain('Not-to-exceed: $150');
    expect(await available('elmwood')).toBe(before - 150);
    const approvals = await ActivityModel.find({ proposalId: id, step: 'approve' }).lean();
    expect(approvals.map((s) => s.actor)).toEqual(['manager']);
    const dispatches = await ActivityModel.find({ proposalId: id, step: 'dispatch' }).lean();
    expect(dispatches.map((s) => s.actor)).toEqual(['system']);
  });

  it('approving twice returns the same work order and commits budget once', async () => {
    const id = await faucet();
    const before = await available('elmwood');
    const first = await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(201);
    const second = await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(200);
    expect(second.body.created).toBe(false);
    expect(second.body.workOrder.id).toBe(first.body.workOrder.id);
    expect(await WorkOrderModel.countDocuments({ proposalId: id })).toBe(1);
    expect(await available('elmwood')).toBe(before - 150);
  });

  it('concurrent approvals create one work order and commit once', async () => {
    const id = await faucet();
    const before = await available('elmwood');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/api/proposals/${id}/approve`).send({})),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.workOrder.id)).size).toBe(1);
    expect(await WorkOrderModel.countDocuments({ proposalId: id })).toBe(1);
    expect(await available('elmwood')).toBe(before - 150);
  });

  it('manager edits are validated with the shared schema and applied on approve', async () => {
    const id = await faucet();
    await request(app).patch(`/api/proposals/${id}`).send({ nte: -5 }).expect(400);
    await request(app).patch(`/api/proposals/${id}`).send({ siteId: 'hertel' }).expect(400);
    await request(app).patch(`/api/proposals/${id}`).send({ budget: 1 }).expect(400);
    await request(app).patch(`/api/proposals/${id}`).send({ assetId: 'hertel-fryer' }).expect(400); // asset at another site
    await request(app)
      .patch(`/api/proposals/${id}`)
      .send({ vendorId: 'v-great-lakes-pest' })
      .expect(400); // wrong trade
    const edited = await request(app)
      .patch(`/api/proposals/${id}`)
      .send({ urgency: 'routine', nte: 200, title: 'Faucet leaking' })
      .expect(200);
    expect(edited.body.draft).toMatchObject({
      urgency: 'routine',
      nte: 200,
      title: 'Faucet leaking',
    });
    const edit = await ActivityModel.findOne({ proposalId: id, step: 'edit' }).lean();
    expect(edit?.actor).toBe('manager');

    const res = await request(app)
      .post(`/api/proposals/${id}/approve`)
      .send({ vendorId: 'v-two-rivers' })
      .expect(201);
    expect(res.body.workOrder).toMatchObject({
      nte: 200,
      urgency: 'routine',
      vendorId: 'v-two-rivers',
    });
  });

  it('refuses an NTE above Available and changes nothing', async () => {
    const id = await propose(
      { type: 'request', siteId: 'cheektowaga', text: 'AC 1 not cooling' },
      { trade: 'hvac', assetId: 'cheektowaga-rtu-1', urgency: 'urgent' },
    );
    const before = await available('cheektowaga');
    const wos = await WorkOrderModel.countDocuments();
    const res = await request(app)
      .post(`/api/proposals/${id}/approve`)
      .send({ nte: 600 })
      .expect(409);
    expect(res.body.error).toMatch(/Available budget/);
    expect(await available('cheektowaga')).toBe(before);
    expect(await WorkOrderModel.countDocuments()).toBe(wos);
    expect((await ProposalModel.findById(id).lean())?.status).toBe('proposed');
    // The capped NTE (350) still goes through.
    await request(app).post(`/api/proposals/${id}/approve`).send({ nte: 350 }).expect(201);
    expect(await available('cheektowaga')).toBe(0);
  });

  it('needsHuman with unknown trade cannot be approved until the manager sets it', async () => {
    const id = await propose(
      {
        type: 'request',
        siteId: 'hertel',
        text: 'the thing in the back is making a weird noise again',
      },
      { trade: 'unknown', confidence: 0.2, clarifyingQuestion: 'Which equipment?' },
    );
    const res = await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(409);
    expect(res.body.error).toMatch(/trade/);
    await request(app)
      .post(`/api/proposals/${id}/approve`)
      .send({ trade: 'refrigeration', assetId: 'hertel-walkin-cooler', nte: 400 })
      .expect(409); // still no vendor chosen
    await request(app)
      .post(`/api/proposals/${id}/approve`)
      .send({
        trade: 'refrigeration',
        assetId: 'hertel-walkin-cooler',
        nte: 400,
        vendorId: 'v-coldline-refrigeration',
      })
      .expect(201);
  });

  it('refuses a vendor whose insurance has expired', async () => {
    const id = await propose(
      { type: 'request', siteId: 'elmwood', text: 'rooftop unit 2 noisy' },
      { trade: 'hvac', assetId: 'elmwood-rtu-2' },
    );
    const res = await request(app)
      .post(`/api/proposals/${id}/approve`)
      .send({ vendorId: 'v-erie-air' })
      .expect(409);
    expect(res.body.error).toMatch(/insurance/);
  });

  it('merge approval adds the report to the existing work order, raises urgency and NTE once', async () => {
    const id = await propose(
      { type: 'request', siteId: 'elmwood', text: "upstairs men's toilet now overflowing" },
      { trade: 'plumbing', assetId: 'elmwood-restroom-mens', urgency: 'urgent' },
      true,
    );
    const p = (await ProposalModel.findById(id).lean())!;
    expect(p.action).toBe('merge');
    const before = await available('elmwood');
    const wosBefore = await WorkOrderModel.countDocuments();

    const res = await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(201);
    expect(res.body.workOrder.id).toBe('wo-seed-001');
    expect(res.body.workOrder).toMatchObject({ urgency: 'urgent', nte: 400, status: 'dispatched' });
    expect(res.body.workOrder.notes).toHaveLength(1);
    expect(res.body.workOrder.dispatchEmail.subject).toMatch(/^Update to WO-/);
    expect(await WorkOrderModel.countDocuments()).toBe(wosBefore);
    expect(await available('elmwood')).toBe(before - 150); // 400 - 250 already committed

    await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(200);
    const wo = (await WorkOrderModel.findById('wo-seed-001').lean())!;
    expect(wo.notes).toHaveLength(1);
    expect(await available('elmwood')).toBe(before - 150);
  });

  it('reject requires a reason, is logged, and blocks later approval', async () => {
    const id = await faucet();
    await request(app).post(`/api/proposals/${id}/reject`).send({}).expect(400);
    const res = await request(app)
      .post(`/api/proposals/${id}/reject`)
      .send({ reason: 'Already fixed by staff' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Already fixed by staff',
    });
    await request(app).post(`/api/proposals/${id}/reject`).send({ reason: 'again' }).expect(200);
    await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(409);
    const log = await ActivityModel.find({ proposalId: id, step: 'reject' }).lean();
    expect(log).toHaveLength(1);
    expect(log[0]?.reason).toBe('Already fixed by staff');
  });

  it('cannot reject an approved proposal; 404 for unknown ids', async () => {
    const id = await faucet();
    await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(201);
    await request(app).post(`/api/proposals/${id}/reject`).send({ reason: 'oops' }).expect(409);
    await request(app).post('/api/proposals/nope/approve').send({}).expect(404);
  });

  it('autonomy dial: advise blocks approval, auto is refused, changes are logged', async () => {
    const id = await faucet();
    const get = await request(app).get('/api/settings/autonomy').expect(200);
    expect(get.body).toEqual({ mode: 'propose', available: ['advise', 'propose'] });

    await request(app).put('/api/settings/autonomy').send({ mode: 'auto' }).expect(409);
    await request(app).put('/api/settings/autonomy').send({ mode: 'yolo' }).expect(400);
    await request(app).put('/api/settings/autonomy').send({ mode: 'advise' }).expect(200);
    const blocked = await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(409);
    expect(blocked.body.error).toMatch(/Advise mode/);
    expect((await request(app).get('/api/health')).body.autonomyMode).toBe('advise');

    await request(app).put('/api/settings/autonomy').send({ mode: 'propose' }).expect(200);
    await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(201);
    expect(await ActivityModel.countDocuments({ step: 'settings' })).toBe(2);
  });

  it('GET /api/work-orders filters by status and site; activity filters by work order', async () => {
    const id = await faucet();
    const approved = await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(201);
    const woId = approved.body.workOrder.id;
    const list = await request(app)
      .get('/api/work-orders?status=dispatched&siteId=elmwood')
      .expect(200);
    expect(list.body.map((w: { id: string }) => w.id)).toContain(woId);
    expect(
      list.body.every(
        (w: { siteId: string; status: string }) =>
          w.siteId === 'elmwood' && w.status === 'dispatched',
      ),
    ).toBe(true);
    const log = await request(app).get(`/api/activity?workOrderId=${woId}`).expect(200);
    const steps = log.body.map((a: { step: string }) => a.step);
    expect(steps).toContain('understand'); // includes the proposal's pipeline steps
    expect(steps).toContain('approve');
    expect(steps).toContain('dispatch');
  });
});

describe('lifecycle state machine', () => {
  it('only allows forward steps in order, plus dispatched -> approved after a decline', () => {
    expect(canTransition('proposed', 'approved')).toBe(true);
    expect(canTransition('approved', 'dispatched')).toBe(true);
    expect(canTransition('dispatched', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
    expect(canTransition('dispatched', 'approved')).toBe(true);
    expect(canTransition('proposed', 'dispatched')).toBe(false);
    expect(canTransition('dispatched', 'proposed')).toBe(false);
    expect(canTransition('accepted', 'approved')).toBe(false);
    expect(canTransition('completed', 'proposed')).toBe(false);
    expect(TRANSITIONS.completed).toEqual([]);
  });
});
