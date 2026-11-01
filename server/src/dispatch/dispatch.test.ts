import request from 'supertest';
import { QuoteResult, estimateCeiling, formatEstimate, type Urgency } from '@fia/shared';
import { createApp } from '../app';
import { finalizeQuote, isPlainYes, normalizeEstimate, overNte } from '../calls/quote';
import { CallModel, type CallDoc } from '../models/call';
import { ActivityModel, ProposalModel } from '../models/pipeline';
import { SettingsModel } from '../models/settings';
import { WorkOrderModel } from '../models/workOrder';
import { createSignal, runPipeline } from '../pipeline/pipeline';
import { resetDemoData } from '../seed/reset';
import {
  ADMIN,
  FakeProvider,
  ScriptedLlm,
  callEnv,
  signedPost,
  type Scripted,
} from '../test/calls';
import { useTestDb } from '../test/db';
import { FakeLlm, understanding } from '../test/fakeLlm';
import { ChainService } from './chain';
import { ChainModel, ScheduledCallModel } from './models';

describe('quote results', () => {
  it('normalizes fixed, range, rates and none', () => {
    const base = { low: null, high: null, callOutFee: null, hourlyRate: null };
    expect(normalizeEstimate({ ...base, quoteType: 'fixed', low: 350 })).toEqual({
      ...base,
      quoteType: 'fixed',
      low: 350,
    });
    // A range given high-first is sorted; a range with one number is a fixed price.
    expect(normalizeEstimate({ ...base, quoteType: 'range', low: 450, high: 300 })).toEqual({
      ...base,
      quoteType: 'range',
      low: 300,
      high: 450,
    });
    expect(normalizeEstimate({ ...base, quoteType: 'range', high: 400 })).toMatchObject({
      quoteType: 'fixed',
      low: 400,
    });
    expect(
      normalizeEstimate({ ...base, quoteType: 'rates', callOutFee: 95, hourlyRate: 120, low: 9 }),
    ).toEqual({ ...base, quoteType: 'rates', callOutFee: 95, hourlyRate: 120 });
    // "Fixed" with only an hourly rate is rates; rates with no numbers is none.
    expect(normalizeEstimate({ ...base, quoteType: 'fixed', hourlyRate: 110 })).toMatchObject({
      quoteType: 'rates',
      hourlyRate: 110,
    });
    expect(normalizeEstimate({ ...base, quoteType: 'rates' })).toEqual({
      ...base,
      quoteType: 'none',
    });
    expect(normalizeEstimate({ ...base, quoteType: 'none', low: 5 })).toEqual({
      ...base,
      quoteType: 'none',
    });
    expect(normalizeEstimate({ quoteType: 'cheap' })).toBeNull();
    expect(normalizeEstimate({ ...base, quoteType: 'fixed', low: -5 })).toBeNull();
  });

  it('recognizes a plain yes to a read-back', () => {
    for (const yes of ['That is right.', 'Yes', "Yeah, that's correct", 'Correct.', 'Sounds good'])
      expect(isPlainYes(yes)).toBe(true);
    for (const no of ['No, day after tomorrow', 'Right, but not before noon', 'Maybe', 'Tuesday'])
      expect(isPlainYes(no)).toBe(false);
  });

  it('compares the right amount with the NTE and formats it', () => {
    const base = { low: null, high: null, callOutFee: null, hourlyRate: null };
    const rates = { ...base, quoteType: 'rates' as const, callOutFee: 95, hourlyRate: 120 };
    expect(estimateCeiling(rates)).toBe(335);
    expect(estimateCeiling({ ...base, quoteType: 'range', low: 300, high: 450 })).toBe(450);
    expect(estimateCeiling({ ...base, quoteType: 'none' })).toBeNull();
    expect(overNte(rates, 300)).toBe(true);
    expect(overNte(rates, 335)).toBe(false);
    expect(overNte(null, 1)).toBe(false);
    expect(formatEstimate(rates)).toBe('$95 call-out + $120/hr');
    expect(formatEstimate({ ...base, quoteType: 'range', low: 300, high: 450 })).toBe('$300–$450');
  });

  it('builds a schema-valid result for each quote type', () => {
    const base = { low: null, high: null, callOutFee: null, hourlyRate: null };
    const at = new Date('2026-11-05T14:00:00Z');
    const cases = [
      { e: { ...base, quoteType: 'fixed' as const, low: 140 }, within: 'yes' },
      { e: { ...base, quoteType: 'range' as const, low: 100, high: 200 }, within: 'unknown' },
      { e: { ...base, quoteType: 'rates' as const, hourlyRate: 60 }, within: 'yes' },
      { e: { ...base, quoteType: 'none' as const }, within: 'unknown' },
    ];
    for (const { e, within } of cases) {
      const q = finalizeQuote({
        estimate: e,
        earliestArrival: at,
        nte: 150,
        nteAsked: false,
        nteAnswer: null,
        notes: ['needs to see it first', 'needs to see it first'],
        confidences: [0.8, 0.6],
      });
      expect(QuoteResult.parse(q)).toEqual(q);
      expect(q.withinNte).toBe(within);
      expect(q).toMatchObject({
        earliestArrival: at.toISOString(),
        notes: 'needs to see it first',
        confidence: 0.7,
      });
    }
    // Asked about the limit: the answer is recorded as given.
    expect(
      finalizeQuote({
        estimate: cases[1]!.e,
        earliestArrival: null,
        nte: 150,
        nteAsked: true,
        nteAnswer: 'no',
        notes: [],
        confidences: [],
      }).withinNte,
    ).toBe('no');
  });
});

describe('call chains', () => {
  const { env: baseEnv } = useTestDb();
  let clock: Date;
  let provider: FakeProvider;
  let script: Scripted[];
  let app: ReturnType<typeof createApp>;
  let chains: ChainService;

  // Wednesday Nov 4 2026, 10:00 AM in Buffalo.
  const START = new Date('2026-11-04T15:00:00Z');
  const now = (): Date => clock;
  const env = callEnv({ DEMO_RETRY_MINUTES: '90', JOBS_SECRET: 'jobs-secret' });

  const build = (e = env) => {
    app = createApp(e, {
      callProvider: provider,
      callLlm: new ScriptedLlm(script),
      llm: new FakeLlm(() => understanding({})),
      now,
    });
    chains = app.locals.chains;
    return app;
  };

  beforeEach(async () => {
    clock = START;
    await resetDemoData('propose', START);
    await CallModel.deleteMany({});
    provider = new FakeProvider();
    script = [];
    build();
  });

  afterEach(async () => {
    await chains.idle();
  });

  void baseEnv;

  async function propose(urgency: Urgency): Promise<string> {
    const llm = new FakeLlm(() =>
      understanding({
        trade: 'plumbing',
        urgency,
        assetId: null,
        problemSummary: 'Toilet running',
        locationText: "men's room",
      }),
    );
    const { id } = await createSignal({
      type: 'request',
      siteId: 'elmwood',
      text: "The toilet in the men's room keeps running",
    });
    const p = await runPipeline(id, { llm, models: { small: 's', big: 'b' }, now });
    expect(p.vendors.length).toBe(3);
    return p._id;
  }

  async function approveWithPlan(
    id: string,
    callPlan: { mode: 'quote' | 'book'; autoBackup: boolean },
    key = ADMIN,
  ) {
    const res = await request(app)
      .post(`/api/proposals/${id}/approve`)
      .set('X-Admin-Key', key)
      .send({ callPlan });
    await chains.idle();
    return res;
  }

  /** The most recently dialed call (the test clock is frozen, so go by the fake's SIDs). */
  const lastCall = async (): Promise<CallDoc> =>
    (await CallModel.findOne({
      callSid: `CA${String(provider.created.length).padStart(32, '0')}`,
    }).lean())!;
  const chainFor = async (woId: string) =>
    (await ChainModel.findOne({ workOrderId: woId }).lean())!;

  /** Answers the current call and plays the vendor's replies; the model replies come from `script`. */
  async function talk(call: CallDoc, replies: string[]): Promise<string[]> {
    const sid = call.callSid!;
    const out = [
      (await signedPost(app, `/api/twilio/voice/${call._id}/answer`, { CallSid: sid })).text,
    ];
    for (const [i, speech] of replies.entries()) {
      const res = await signedPost(app, `/api/twilio/voice/${call._id}/turn?n=${i + 1}`, {
        CallSid: sid,
        SpeechResult: speech,
        Confidence: '0.9',
      });
      out.push(res.text);
    }
    return out;
  }

  async function end(call: CallDoc, status = 'completed'): Promise<void> {
    await signedPost(app, `/api/twilio/voice/${call._id}/status`, {
      CallSid: call.callSid!,
      CallStatus: status,
      CallDuration: '40',
    });
    await chains.idle();
  }

  const fixed = (low: number) => ({
    quoteType: 'fixed' as const,
    low,
    high: null,
    callOutFee: null,
    hourlyRate: null,
  });

  /** A full quote call: identity, price, "tomorrow at <time>", yes (and the limit if asked). */
  async function quote(call: CallDoc, price: number, time: string, limit?: 'yes' | 'no') {
    script.push(
      { say: 'Great, thanks.' },
      { say: 'Thanks.', estimate: fixed(price) },
      { say: 'Okay.' },
      {
        action: 'agree',
      },
    );
    const replies = ['Yes, that is us', `About ${price} dollars`, `Tomorrow at ${time}`, 'Yes'];
    if (limit) {
      script.push({ action: limit === 'yes' ? 'agree' : 'continue', withinNte: limit });
      replies.push(limit === 'yes' ? 'Yes, we can do that' : "No, we can't");
    }
    const twiml = await talk(call, replies);
    await end(call);
    return twiml;
  }

  it('a plain "That is right" confirms the read-back even when the model says continue', async () => {
    const id = await propose('routine');
    await approveWithPlan(id, { mode: 'quote', autoBackup: false });
    const call = await lastCall();
    script.push(
      { say: 'Great, thanks.' },
      { say: 'Thanks.', estimate: fixed(120) },
      { say: 'Okay.' },
      { say: 'Thank you. We will note that.' },
    );
    const twiml = await talk(call, [
      'You are',
      'About 120 dollars',
      'Tomorrow at 10 am',
      'That is right.',
    ]);
    expect(twiml[4]).toContain('Our manager will confirm shortly');
    await end(call);
    const q = (await CallModel.findById(call._id).lean())!.quote!;
    expect(q.earliestArrival).toBe(new Date('2026-11-05T15:00:00Z').toISOString());
  });

  it('Lakeshore bug: a confirmed read-back is saved even when the model ends the call or echoes another day', async () => {
    const id = await propose('routine');
    await approveWithPlan(id, { mode: 'quote', autoBackup: false });
    const call = await lastCall();
    script.push(
      { say: 'Great, thanks.' },
      { say: 'Thanks.', estimate: fixed(120) },
      // The model reads "November 2" as the 3rd: the read-back must still use what was heard.
      { say: 'Okay.', arrivalTime: '2026-11-06T10:00' },
      // On the yes it echoes a different day and ends the call.
      { say: 'Great, bye.', action: 'end', arrivalTime: '2026-11-07T10:00' },
    );
    await talk(call, ['Yes', 'About 120 dollars', 'Friday at 10 am', "Yes that's right, bye"]);
    await end(call);
    const done = (await CallModel.findById(call._id).lean())!;
    expect(done.outcome).toBe('quoted');
    expect(done.quote!.earliestArrival).toBe(new Date('2026-11-06T15:00:00Z').toISOString());
    expect(done.summary).not.toContain('no arrival time');
  });

  it('Quote mode: one call at a time, quotes ready, pick → booking call → accepted + decline draft', async () => {
    const id = await propose('routine');
    const res = await approveWithPlan(id, { mode: 'quote', autoBackup: false });
    expect(res.status).toBe(201);
    const woId = res.body.workOrder.id;
    let wo = (await WorkOrderModel.findById(woId).lean())!;
    expect(wo).toMatchObject({ status: 'approved', vendorId: null, dispatchEmail: null });

    // Only the first vendor is dialed while that call is on the line.
    expect(provider.created).toHaveLength(1);
    await chains.runDue();
    expect(provider.created).toHaveLength(1);
    const first = await lastCall();
    expect(first.purpose).toBe('quote');

    // NTE for routine plumbing at Elmwood is below 300: the limit question comes once.
    const twiml = await quote(first, 300, '9 am', 'yes');
    expect(twiml[1]).toContain(
      "Roughly what would that run? A ballpark's fine, or just your call-out fee and hourly rate.",
    );
    expect(twiml[1]).not.toContain('not-to-exceed');
    expect(twiml[3]).toContain("Okay, so that's tomorrow at 9 AM, right?");
    expect(twiml[4]).toMatch(
      /Just so you know, our limit on this one is \d+ dollars\. Any chance you could work within that\?/,
    );
    expect(twiml[5]).toContain('Our manager will confirm shortly');
    expect(twiml.join(' ')).not.toMatch(/\bbook(ed)?\b/i);
    const q1 = (await CallModel.findById(first._id).lean())!;
    expect(q1.outcome).toBe('quoted');
    expect(q1.quote).toMatchObject({ quoteType: 'fixed', low: 300, withinNte: 'yes' });

    // The second vendor is called only after the first call's final status.
    expect(provider.created).toHaveLength(2);
    const second = await lastCall();
    expect(second.vendorId).not.toBe(first.vendorId);
    await quote(second, 120, '2 pm');
    const q2 = (await CallModel.findById(second._id).lean())!;
    expect(q2.quote).toMatchObject({ low: 120, withinNte: 'yes' });
    expect(q2.transcript.map((t) => t.text).join(' ')).not.toContain('Our limit');

    let chain = await chainFor(woId);
    expect(chain.phase).toBe('quotes_ready');
    const proposal = (await ProposalModel.findById(chain.proposalId).lean())!;
    expect(proposal).toMatchObject({ action: 'quotes', status: 'proposed' });
    expect(proposal.draft.vendorId).toBeNull();
    expect(proposal.quotes!.cards.map((c) => c.vendorId)).toEqual([
      first.vendorId,
      second.vendorId,
    ]);
    expect(proposal.quotes!.cheapestVendorId).toBe(second.vendorId);
    expect(proposal.quotes!.soonestVendorId).toBe(first.vendorId);

    // Approving without a pick fails; picking someone who didn't quote fails.
    await request(app).post(`/api/proposals/${proposal._id}/approve`).send({}).expect(409);
    await request(app)
      .post(`/api/proposals/${proposal._id}/approve`)
      .send({ vendorId: 'v-handyman-pro' })
      .expect(400);

    const pick = await request(app)
      .post(`/api/proposals/${proposal._id}/approve`)
      .send({ vendorId: second.vendorId })
      .expect(201);
    await chains.idle();
    expect(pick.body.workOrder).toMatchObject({ status: 'dispatched', vendorId: second.vendorId });

    const booking = await lastCall();
    expect(provider.created).toHaveLength(3);
    expect(booking).toMatchObject({ purpose: 'book', vendorId: second.vendorId });
    expect(booking.bookingQuote).toMatchObject({ low: 120 });
    script.push({ say: 'Great, thanks.' }, { action: 'confirm_job' });
    const bt = await talk(booking, ['Yes, speaking', 'Yes, I can be there']);
    expect(bt[1]).toContain("You'd quoted us about 120 dollars.");
    expect(bt[1]).toContain('Does tomorrow at 2 PM still work for you?');
    expect(bt[2]).toContain("you're all set for tomorrow at 2 PM");
    await end(booking);

    wo = (await WorkOrderModel.findById(woId).lean())!;
    expect(wo.status).toBe('accepted');
    expect(wo.eta?.toISOString()).toBe('2026-11-05T19:00:00.000Z');
    expect(wo.agreedQuote).toMatchObject({ quoteType: 'fixed', low: 120 });
    chain = await chainFor(woId);
    expect(chain.phase).toBe('booked');
    expect(chain.emails).toHaveLength(1);
    expect(chain.emails[0]).toMatchObject({ kind: 'decline', vendorId: first.vendorId });
    expect(chain.emails[0]!.email.body).toContain("We've gone with another provider this time");
    expect(chain.emails[0]!.email.sent).toBe(false);

    const log = (await ActivityModel.find({ workOrderId: woId }).sort({ timestamp: 1 }).lean()).map(
      (a) => a.inputSummary,
    );
    for (const want of [
      /Call chain for WO-\d+: Quote mode/,
      /Quote captured from/,
      /Quotes ready/,
      /Picked .* from 2 quotes/,
      /Manager picked/,
      /booked for/,
      /Decline email for/,
    ]) {
      expect(log.some((l) => want.test(l))).toBe(true);
    }

    // The chain's own API view.
    const view = await request(app).get(`/api/work-orders/${woId}/chain`).expect(200);
    expect(view.body).toMatchObject({ mode: 'quote', phase: 'booked' });
  });

  it('asks the limit question only when over the NTE, and only once', async () => {
    const id = await propose('routine');
    await approveWithPlan(id, { mode: 'quote', autoBackup: false });
    const call = await lastCall();
    // Over the limit; the vendor answers "maybe" and states another price: no second ask.
    script.push(
      { say: 'Great, thanks.' },
      { estimate: { ...fixed(500), quoteType: 'range', high: 700 } },
      {},
      { action: 'agree' },
      { withinNte: 'maybe', estimate: fixed(450) },
    );
    const twiml = await talk(call, ['Yes', '500 to 700', 'Tomorrow at 9 am', 'Yes', 'Maybe 450']);
    expect(twiml.filter((t) => t.includes('our limit on this one')).length).toBe(1);
    expect(twiml[5]).toContain('Our manager will confirm shortly');
    const done = (await CallModel.findById(call._id).lean())!;
    expect(done.quote).toMatchObject({ quoteType: 'fixed', low: 450, withinNte: 'maybe' });
  });

  it('Routine: missed quote call → RFQ draft + retry after the delay; second miss → next vendor', async () => {
    const id = await propose('routine');
    const res = await approveWithPlan(id, { mode: 'quote', autoBackup: false });
    const woId = res.body.workOrder.id;
    const a = await lastCall();
    await end(a, 'no-answer');

    let chain = await chainFor(woId);
    const retry = (await ScheduledCallModel.findOne({
      chainId: chain._id,
      purpose: 'retry',
    }).lean())!;
    expect(retry.dueAt.toISOString()).toBe(new Date(START.getTime() + 90 * 60_000).toISOString());
    expect(chain.emails.map((e) => e.kind)).toEqual(['rfq']);
    expect(chain.emails[0]!.email.sent).toBe(false);

    // Meanwhile vendor #2 is called right away.
    const b = await lastCall();
    expect(b.vendorId).not.toBe(a.vendorId);
    await quote(b, 140, '9 am');
    expect(provider.created).toHaveLength(2);

    // Nothing runs before the retry is due.
    clock = new Date(START.getTime() + 89 * 60_000);
    expect(await chains.runDue()).toBe(0);
    clock = new Date(START.getTime() + 91 * 60_000);
    expect(await chains.runDue()).toBe(1);
    const aAgain = await lastCall();
    expect(aAgain.vendorId).toBe(a.vendorId);
    await end(aAgain, 'busy');

    // Retry missed too: vendor #3 takes the slot.
    const c = await lastCall();
    expect(new Set([a.vendorId, b.vendorId, c.vendorId]).size).toBe(3);
    await quote(c, 130, '11 am');
    chain = await chainFor(woId);
    expect(chain.phase).toBe('quotes_ready');
    expect(chain.vendors.find((v) => v.vendorId === a.vendorId)).toMatchObject({
      state: 'dropped',
      quoteAttempts: 2,
    });
  });

  it('Urgent: a missed quote call moves straight to the next vendor (no retry)', async () => {
    const id = await propose('urgent');
    await approveWithPlan(id, { mode: 'quote', autoBackup: false });
    const a = await lastCall();
    await end(a, 'no-answer');
    expect(await ScheduledCallModel.countDocuments({ purpose: 'retry' })).toBe(0);
    const b = await lastCall();
    await end(b, 'no-answer');
    const c = await lastCall();
    expect(new Set([a.vendorId, b.vendorId, c.vendorId]).size).toBe(3);
    await quote(c, 200, '9 am');
    // Everyone else is out: quotes ready with the one quote.
    const chain = await chainFor(a.workOrderId);
    expect(chain.phase).toBe('quotes_ready');
    const p = (await ProposalModel.findById(chain.proposalId).lean())!;
    expect(p.quotes!.cards).toHaveLength(1);
    expect(p.quotes!.cheapestVendorId).toBeNull();
  });

  it('every vendor missed → needs a human: "No vendor reached"', async () => {
    const id = await propose('urgent');
    const res = await approveWithPlan(id, { mode: 'quote', autoBackup: false });
    for (let i = 0; i < 3; i++) await end(await lastCall(), 'no-answer');
    expect(provider.created).toHaveLength(3);
    const chain = await chainFor(res.body.workOrder.id);
    expect(chain.phase).toBe('needs_human');
    const p = (await ProposalModel.findById(chain.proposalId).lean())!;
    expect(p).toMatchObject({
      needsHuman: true,
      needsHumanReason: 'No vendor reached',
      action: 'reassign',
    });
    expect(p.draft.vendorId).toBeNull();
    expect(await chains.runDue()).toBe(0);
  });

  it('Emergency, Book mode with auto-backup: #1 misses → #2 declines → #3 misses → needs a human', async () => {
    const id = await propose('emergency');
    const res = await approveWithPlan(id, { mode: 'book', autoBackup: true });
    const woId = res.body.workOrder.id;
    expect(res.body.workOrder.status).toBe('dispatched');
    const a = await lastCall();
    expect(a).toMatchObject({ purpose: 'book', vendorId: res.body.workOrder.vendorId });
    await end(a, 'no-answer');

    // The work order moves to #2 (new email draft) and #2 is called immediately.
    const b = await lastCall();
    let wo = (await WorkOrderModel.findById(woId).lean())!;
    expect(wo).toMatchObject({ status: 'dispatched', vendorId: b.vendorId });
    expect(b.vendorId).not.toBe(a.vendorId);
    script.push(
      { say: 'Great, thanks.' },
      { say: "Sorry, we can't. Goodbye.", action: 'decline_job', reason: 'Fully booked' },
    );
    await talk(b, ['Yes', "Sorry, we're fully booked"]);
    await end(b);

    const c = await lastCall();
    expect(new Set([a.vendorId, b.vendorId, c.vendorId]).size).toBe(3);
    await end(c, 'no-answer');
    wo = (await WorkOrderModel.findById(woId).lean())!;
    expect(wo).toMatchObject({ status: 'approved', vendorId: null });
    expect(wo.declinedVendorIds).toEqual([b.vendorId]);
    const chain = await chainFor(woId);
    expect(chain.phase).toBe('needs_human');
    expect((await ProposalModel.findById(chain.proposalId).lean())!.needsHumanReason).toBe(
      'No vendor reached',
    );
    const log = (await ActivityModel.find({ workOrderId: woId }).lean()).map((l) => l.inputSummary);
    expect(log.filter((l) => l.startsWith('Auto-backup on'))).toHaveLength(2);
  });

  it('Book mode without auto-backup: a miss proposes the next vendor; approving it calls them', async () => {
    const id = await propose('emergency');
    const res = await approveWithPlan(id, { mode: 'book', autoBackup: false });
    const a = await lastCall();
    await end(a, 'no-answer');
    expect(provider.created).toHaveLength(1);
    const chain = await chainFor(res.body.workOrder.id);
    expect(chain.phase).toBe('awaiting_approval');
    const p = (await ProposalModel.findById(chain.proposalId).lean())!;
    expect(p.action).toBe('reassign');
    expect(p.draft.vendorId).not.toBe(a.vendorId);
    // A miss isn't a decline: vendor #1 isn't barred from the job.
    expect((await WorkOrderModel.findById(a.workOrderId).lean())!.declinedVendorIds).toEqual([]);

    await request(app).post(`/api/proposals/${p._id}/approve`).send({}).expect(201);
    await chains.idle();
    expect(provider.created).toHaveLength(2);
    expect((await lastCall()).vendorId).toBe(p.draft.vendorId);
  });

  async function quotesReady(urgency: Urgency) {
    const id = await propose(urgency);
    const res = await approveWithPlan(id, { mode: 'quote', autoBackup: false });
    const a = await lastCall();
    await quote(a, 140, '9 am');
    const b = await lastCall();
    await quote(b, 130, '10 am');
    const chain = await chainFor(res.body.workOrder.id);
    return { woId: res.body.workOrder.id as string, a, b, proposalId: chain.proposalId! };
  }

  it('Urgent: winner misses the booking call → runner-up offered at once, with their quote', async () => {
    const { a, b, proposalId } = await quotesReady('urgent');
    await request(app)
      .post(`/api/proposals/${proposalId}/approve`)
      .send({ vendorId: b.vendorId })
      .expect(201);
    await chains.idle();
    await end(await lastCall(), 'no-answer');
    const chain = await chainFor(a.workOrderId);
    expect(chain.phase).toBe('awaiting_approval');
    const runnerUp = (await ProposalModel.findById(chain.proposalId).lean())!;
    expect(runnerUp.draft.vendorId).toBe(a.vendorId);

    await request(app).post(`/api/proposals/${runnerUp._id}/approve`).send({}).expect(201);
    await chains.idle();
    const call = await lastCall();
    expect(call).toMatchObject({ purpose: 'book', vendorId: a.vendorId });
    expect(call.bookingQuote).toMatchObject({ low: 140 });
  });

  it('Routine: winner misses the booking call → one retry after the delay, then the runner-up', async () => {
    const { a, b, proposalId } = await quotesReady('routine');
    await request(app)
      .post(`/api/proposals/${proposalId}/approve`)
      .send({ vendorId: b.vendorId })
      .expect(201);
    await chains.idle();
    await end(await lastCall(), 'no-answer');
    expect((await chainFor(a.workOrderId)).phase).toBe('booking');
    clock = new Date(START.getTime() + 91 * 60_000);
    expect(await chains.runDue()).toBe(1);
    const retry = await lastCall();
    expect(retry.vendorId).toBe(b.vendorId);
    await end(retry, 'no-answer');
    const chain = await chainFor(a.workOrderId);
    expect(chain.phase).toBe('awaiting_approval');
    expect((await ProposalModel.findById(chain.proposalId).lean())!.draft.vendorId).toBe(
      a.vendorId,
    );
  });

  it('reject all quotes → the next unused vendor is called for a quote; none left → needs a human', async () => {
    const { a, b, proposalId } = await quotesReady('routine');
    await request(app)
      .post(`/api/proposals/${proposalId}/reject`)
      .send({ reason: 'Both too slow' })
      .expect(200);
    await chains.idle();
    const c = await lastCall();
    expect(c.purpose).toBe('quote');
    expect(new Set([a.vendorId, b.vendorId, c.vendorId]).size).toBe(3);
    await quote(c, 125, '8 am');
    let chain = await chainFor(a.workOrderId);
    expect(chain.phase).toBe('quotes_ready');
    const second = (await ProposalModel.findById(chain.proposalId).lean())!;
    expect(second.quotes!.cards.map((x) => x.vendorId)).toEqual([c.vendorId]);
    await request(app)
      .post(`/api/proposals/${second._id}/reject`)
      .send({ reason: 'Still too slow' })
      .expect(200);
    await chains.idle();
    chain = await chainFor(a.workOrderId);
    expect(chain.phase).toBe('needs_human');
  });

  describe('scheduler', () => {
    /** Routine chain where vendor #1 missed and vendor #2 quoted: one retry job is pending. */
    async function pendingRetry() {
      const id = await propose('routine');
      await approveWithPlan(id, { mode: 'quote', autoBackup: false });
      await end(await lastCall(), 'no-answer');
      await quote(await lastCall(), 140, '9 am');
      return (await ScheduledCallModel.findOne({ purpose: 'retry', status: 'pending' }).lean())!;
    }

    it('runs a due job once, even when two runs overlap', async () => {
      await pendingRetry();
      clock = new Date(START.getTime() + 91 * 60_000);
      // The second request joins the run already in progress.
      const [n1, n2] = await Promise.all([chains.runDue(), chains.runDue()]);
      expect([n1, n2]).toEqual([1, 1]);
      expect(provider.created).toHaveLength(3);
      expect(await chains.runDue()).toBe(0);
      expect(provider.created).toHaveLength(3);
    });

    it('a job left running by a crash is picked up again without dialing twice', async () => {
      const job = await pendingRetry();
      clock = new Date(START.getTime() + 91 * 60_000);
      // The crash happened after the call was placed but before the job was marked done.
      const placed = (await CallModel.findOne().sort({ createdAt: -1 }).lean())!;
      await CallModel.create({
        ...placed,
        _id: `call_${job._id}`,
        callSid: 'CAcrash',
        endedAt: clock,
      });
      await ScheduledCallModel.updateOne(
        { _id: job._id },
        { status: 'running', claimedAt: new Date(clock.getTime() - 5 * 60_000) },
      );
      await chains.runDue();
      expect(provider.created).toHaveLength(2);
      expect((await ScheduledCallModel.findById(job._id).lean())!).toMatchObject({
        status: 'done',
        callId: `call_${job._id}`,
      });
    });

    it('pending jobs survive a restart and run on the next start', async () => {
      const id = await propose('routine');
      await approveWithPlan(id, { mode: 'quote', autoBackup: false });
      await end(await lastCall(), 'no-answer');
      await quote(await lastCall(), 140, '9 am');
      expect(await ScheduledCallModel.countDocuments({ status: 'pending' })).toBe(1);

      // A fresh process (new app, same database) after the server slept past the due time.
      await chains.idle();
      clock = new Date(START.getTime() + 3 * 3600_000);
      build();
      expect(await chains.runDue()).toBe(1);
      expect(await ScheduledCallModel.countDocuments({ status: 'pending' })).toBe(0);
    });

    it('a stale call without a final status frees the line and the chain moves on', async () => {
      const id = await propose('urgent');
      await approveWithPlan(id, { mode: 'quote', autoBackup: false });
      const a = await lastCall();
      clock = new Date(START.getTime() + 10 * 60_000);
      expect(await chains.runDue()).toBe(1);
      const stale = (await CallModel.findById(a._id).lean())!;
      expect(stale).toMatchObject({ status: 'ended', outcome: 'email_fallback' });
      expect((await lastCall()).vendorId).not.toBe(a.vendorId);
    });

    it('POST /api/jobs/run-due needs the jobs secret', async () => {
      await request(app).post('/api/jobs/run-due').expect(401);
      await request(app).post('/api/jobs/run-due').set('X-Jobs-Secret', 'nope').expect(401);
      const ok = await request(app).post('/api/jobs/run-due').set('X-Jobs-Secret', 'jobs-secret');
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ placed: 0 });
      build(callEnv());
      await request(app).post('/api/jobs/run-due').set('X-Jobs-Secret', 'x').expect(503);
    });
  });

  describe('gates and caps', () => {
    it('a call plan needs the admin key and CALLS_ENABLED; nothing is approved without them', async () => {
      const id = await propose('routine');
      await approveWithPlan(id, { mode: 'quote', autoBackup: false }, 'wrong').then((r) =>
        expect(r.status).toBe(401),
      );
      build(callEnv({ CALLS_ENABLED: 'false' }));
      await approveWithPlan(id, { mode: 'quote', autoBackup: false }).then((r) =>
        expect(r.status).toBe(403),
      );
      expect((await ProposalModel.findById(id).lean())!.status).toBe('proposed');
      expect(provider.created).toHaveLength(0);
      // Without a plan, approval dispatches by email as before and places no call.
      await request(app).post(`/api/proposals/${id}/approve`).send({}).expect(201);
      await chains.idle();
      expect(provider.created).toHaveLength(0);
    });

    it('Advise mode: scheduled calls wait', async () => {
      const id = await propose('routine');
      await approveWithPlan(id, { mode: 'quote', autoBackup: false });
      await end(await lastCall(), 'no-answer');
      await quote(await lastCall(), 140, '9 am');
      await SettingsModel.updateOne({ _id: 'global' }, { autonomyMode: 'advise' });
      clock = new Date(START.getTime() + 3 * 3600_000);
      expect(await chains.runDue()).toBe(0);
      expect(await ScheduledCallModel.countDocuments({ status: 'pending' })).toBe(1);
    });

    it('the per-work-order cap ends the chain with a needs-human proposal', async () => {
      const id = await propose('urgent');
      const res = await approveWithPlan(id, { mode: 'quote', autoBackup: false });
      const woId = res.body.workOrder.id;
      // Five earlier calls on this work order (e.g. manual ones): the sixth is this chain's first.
      const first = await lastCall();
      const fakes = Array.from({ length: 5 }, (_, i) => ({
        ...first,
        _id: `call_old_${i}`,
        callSid: null,
        chainId: null,
        endedAt: START,
        status: 'ended',
        createdAt: new Date(START.getTime() - (i + 1) * 60_000),
      }));
      await CallModel.insertMany(fakes);
      await end(first, 'no-answer');
      expect(provider.created).toHaveLength(1);
      const chain = await chainFor(woId);
      expect(chain.phase).toBe('needs_human');
      expect((await ProposalModel.findById(chain.proposalId).lean())!.needsHumanReason).toContain(
        'Call limit reached (6 calls',
      );
    });

    it('the hourly cap postpones the next chain call instead of dropping it', async () => {
      const id = await propose('urgent');
      await approveWithPlan(id, { mode: 'quote', autoBackup: false });
      const first = await lastCall();
      await CallModel.insertMany(
        Array.from({ length: 11 }, (_, i) => ({
          ...first,
          _id: `call_other_${i}`,
          workOrderId: `wo_other_${i}`,
          callSid: null,
          chainId: null,
          endedAt: START,
          status: 'ended',
          createdAt: new Date(START.getTime() - (i + 1) * 60_000),
        })),
      );
      await end(first, 'no-answer');
      expect(provider.created).toHaveLength(1);
      const pending = await ScheduledCallModel.find({ status: 'pending' }).lean();
      expect(pending.map((j) => j.dueAt.getTime())).toContain(START.getTime() + 10 * 60_000);
      expect(await chains.runDue()).toBe(0);
    });
  });
});
