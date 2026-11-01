import { createApp } from '../app';
import { CallModel, type CallDoc } from '../models/call';
import { ActivityModel } from '../models/pipeline';
import { WorkOrderModel } from '../models/workOrder';
import { resetDemoData } from '../seed/reset';
import { FakeProvider, ScriptedLlm, callEnv, signedPost, type Scripted } from '../test/calls';
import { useTestDb } from '../test/db';
import {
  MAX_SENTENCE_WORDS,
  jobSentence,
  problemShort,
  spokenVendorName,
  wordCount,
} from './script';
import type { CallService } from './service';

/**
 * Golden transcripts: speech and model decisions are mocked; the agent's spoken lines must match
 * the script word for word and keep every sentence under the word limit.
 */
describe('golden call transcripts', () => {
  useTestDb();
  let clock: Date;
  let script: Scripted[];
  let app: ReturnType<typeof createApp>;
  const WO = 'wo_golden_mop_sink';
  const VENDOR = 'v-queen-city-drain';

  // Quote call: Saturday Oct 31 2026, 2 PM in Buffalo. Booking call: Monday Nov 2, 10 AM.
  const SATURDAY = new Date('2026-10-31T18:00:00Z');
  const MONDAY = new Date('2026-11-02T15:00:00Z');
  const TUESDAY_11 = new Date('2026-11-03T16:00:00Z');

  beforeEach(async () => {
    clock = SATURDAY;
    await resetDemoData('propose', SATURDAY);
    await CallModel.deleteMany({});
    script = [];
    app = createApp(callEnv(), {
      callProvider: new FakeProvider(),
      callLlm: new ScriptedLlm(script),
      now: () => clock,
    });
    await WorkOrderModel.create({
      _id: WO,
      number: 'WO-9001',
      siteId: 'elmwood',
      assetId: null,
      trade: 'plumbing',
      title: 'Mop sink clogged and backing up',
      description: 'The mop sink is clogged and backing up.',
      locationText: 'Back hallway',
      urgency: 'routine',
      nte: 200,
      vendorId: null,
      status: 'approved',
      proposalId: null,
      notes: [],
      dispatchEmail: null,
      actualCost: null,
      createdAt: SATURDAY,
      updatedAt: SATURDAY,
      closedAt: null,
    });
  });

  const calls = (): CallService => app.locals.calls as CallService;

  /** Plays a call; returns the agent's line for each webhook, as the transcript records it. */
  async function play(call: CallDoc, replies: string[]): Promise<string[]> {
    const sid = call.callSid!;
    await signedPost(app, `/api/twilio/voice/${call._id}/answer`, { CallSid: sid }).expect(200);
    for (const [i, speech] of replies.entries()) {
      await signedPost(app, `/api/twilio/voice/${call._id}/turn?n=${i + 1}`, {
        CallSid: sid,
        SpeechResult: speech,
        Confidence: '0.9',
      }).expect(200);
    }
    await signedPost(app, `/api/twilio/voice/${call._id}/status`, {
      CallSid: sid,
      CallStatus: 'completed',
      CallDuration: '60',
    });
    const done = (await CallModel.findById(call._id).lean())!;
    return done.transcript.filter((t) => t.speaker === 'agent').map((t) => t.text);
  }

  function expectShort(lines: string[]): void {
    for (const line of lines) {
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        expect(wordCount(sentence)).toBeLessThanOrEqual(MAX_SENTENCE_WORDS);
      }
      expect(line).not.toMatch(/WO-?\s?\d|work order|\d \d \d/i);
    }
  }

  const rates50 = {
    quoteType: 'rates' as const,
    low: null,
    high: null,
    callOutFee: null,
    hourlyRate: 50,
  };

  async function quoteCall(): Promise<CallDoc> {
    const call = await calls().place({
      workOrderId: WO,
      vendorId: VENDOR,
      purpose: 'quote',
      chainId: null,
      actor: 'manager',
    });
    script.push(
      {},
      { vendorQuestion: 'Is it just that sink?', answer: null },
      { estimate: rates50 },
      { arrivalTime: '2026-11-03T11:00' },
    );
    const agent = await play(call, [
      'Yeah.',
      'Is it just that sink?',
      'About fifty an hour.',
      'Tuesday at eleven.',
    ]);
    expect(agent).toEqual([
      'Hi, this is an automated assistant calling for Harbor and Hearth Kitchen. Is this Queen City Drain?',
      'Great. The mop sink at our Elmwood location is clogged and backing up. Not urgent, sometime this week. Roughly what would that cost?',
      "I don't have that detail. Our manager can fill you in. Roughly what would that cost?",
      "Got it. When's the earliest you could get there?",
      'Tuesday the 3rd at 11 AM, got it. Thanks. Our manager will get back to you soon. If you need us, this number calls us back. Have a good one.',
    ]);
    expectShort(agent);
    return (await CallModel.findById(call._id).lean())!;
  }

  it('quote flow', async () => {
    const done = await quoteCall();
    expect(done.outcome).toBe('quoted');
    expect(done.quote).toMatchObject({
      quoteType: 'rates',
      hourlyRate: 50,
      withinNte: 'yes',
      earliestArrival: TUESDAY_11.toISOString(),
    });
    expect(done.summary).toContain('earliest arrival Tue, Nov 3, 11:00 AM');
    // The unanswered vendor question is in the Activity Log.
    const asked = await ActivityModel.find({ workOrderId: WO, step: 'call' }).lean();
    expect(asked.map((a) => a.outputSummary)).toContain('Vendor asked: Is it just that sink?');
  });

  async function bookingCall(): Promise<CallDoc> {
    const quoted = await quoteCall();
    clock = MONDAY;
    await WorkOrderModel.updateOne({ _id: WO }, { status: 'dispatched', vendorId: VENDOR });
    return calls().place({
      workOrderId: WO,
      vendorId: VENDOR,
      purpose: 'book',
      chainId: null,
      actor: 'manager',
      bookingQuote: quoted.quote,
    });
  }

  it('booking flow', async () => {
    const call = await bookingCall();
    script.push({}, {});
    const agent = await play(call, ['Oh yeah.', 'Yep.']);
    expect(agent).toEqual([
      'Hi, this is the automated assistant from Harbor and Hearth Kitchen. We called you Saturday about the clogged mop sink at our Elmwood location.',
      "Great news, we'd like to book you. Does Tuesday at 11 AM still work?",
      'Perfect, Tuesday at 11 AM. The address is 812 Elmwood Ave. Thanks!',
    ]);
    expectShort(agent);
    const wo = (await WorkOrderModel.findById(WO).lean())!;
    expect(wo.status).toBe('accepted');
    expect(wo.eta?.toISOString()).toBe(TUESDAY_11.toISOString());
  });

  it('booking flow: a vendor who does not recall hears the job again, then the question', async () => {
    const call = await bookingCall();
    script.push({}, {});
    const agent = await play(call, ["Sorry, I don't remember that one.", 'Yes, that works.']);
    expect(agent[1]).toBe(
      "The mop sink at our Elmwood location is clogged and backing up. Great news, we'd like to book you. Does Tuesday at 11 AM still work?",
    );
    expect(agent[2]).toBe('Perfect, Tuesday at 11 AM. The address is 812 Elmwood Ave. Thanks!');
    expectShort(agent);
  });

  it('book mode (no quote call): opener, job, "Can you take it", clear time books it', async () => {
    clock = MONDAY;
    await WorkOrderModel.updateOne({ _id: WO }, { status: 'dispatched', vendorId: VENDOR });
    const call = await calls().place({
      workOrderId: WO,
      vendorId: VENDOR,
      purpose: 'book',
      chainId: null,
      actor: 'manager',
    });
    script.push({}, { arrivalTime: '2026-11-03T11:00' });
    const agent = await play(call, ['Yes it is.', 'Sure, Tuesday at eleven.']);
    expect(agent).toEqual([
      'Hi, this is an automated assistant calling for Harbor and Hearth Kitchen. Is this Queen City Drain?',
      "Great. The mop sink at our Elmwood location is clogged and backing up. Not urgent, sometime this week. Can you take it, and when's the earliest you could get there?",
      'Perfect, Tuesday the 3rd at 11 AM. The address is 812 Elmwood Ave. Thanks!',
    ]);
    expectShort(agent);
    expect((await WorkOrderModel.findById(WO).lean())!.eta?.toISOString()).toBe(
      TUESDAY_11.toISOString(),
    );
  });

  it('quote flow: a vague time is read back with "Is that right?" and a yes saves it', async () => {
    const call = await calls().place({
      workOrderId: WO,
      vendorId: VENDOR,
      purpose: 'quote',
      chainId: null,
      actor: 'manager',
    });
    script.push({}, { estimate: rates50 }, {}, {});
    const agent = await play(call, [
      'Yeah.',
      'Fifty an hour.',
      '10 a.m. from 2 days',
      "Yeah that's right.",
    ]);
    expect(agent[3]).toBe('Monday the 2nd at 10 AM. Is that right?');
    expect(agent[4]).toMatch(/^Thanks\. Our manager will get back to you soon\./);
    expectShort(agent);
    const done = (await CallModel.findById(call._id).lean())!;
    expect(done.quote!.earliestArrival).toBe('2026-11-02T15:00:00.000Z');
  });
});

describe('script helpers', () => {
  it.each([
    ['Queen City Drain & Pipe', 'Queen City Drain'],
    ['Lakeshore Plumbing Co.', 'Lakeshore Plumbing'],
    ['Niagara Frontier HVAC', 'Niagara Frontier HVAC'],
    ['Acme Services, Inc.', 'Acme Services'],
  ])('spokenVendorName(%s)', (name, expected) => {
    expect(spokenVendorName(name)).toBe(expected);
  });

  it.each([
    [
      'The mop sink is clogged and backing up.',
      'Mop sink clogged',
      'The mop sink at our Elmwood location is clogged and backing up.',
    ],
    [
      'The faucet in the kitchen is leaking under the sink, please help',
      'Faucet leaking',
      'The faucet in the kitchen at our Elmwood location is leaking under the sink.',
    ],
    [
      'Staff report the toilet upstairs keeps running.',
      'Toilet running constantly',
      'Toilet running constantly at our Elmwood location.',
    ],
  ])('jobSentence(%s)', (request, title, expected) => {
    expect(jobSentence(request, title, 'Elmwood')).toBe(expected);
  });

  it.each([
    ['Mop sink clogged and backing up', 'clogged mop sink'],
    ["Toilet running constantly in men's room", 'running toilet'],
    ['Dishwasher not draining', 'dishwasher'],
    ['No hot water at hand sinks', 'hot water problem'],
  ])('problemShort(%s)', (title, expected) => {
    expect(problemShort(title)).toBe(expected);
  });
});
