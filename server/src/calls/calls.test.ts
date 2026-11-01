import request from 'supertest';
import twilio from 'twilio';
import { createApp } from '../app';
import { LlmError, type LlmClient } from '../llm/client';
import { CallModel } from '../models/call';
import { VendorModel } from '../models/catalog';
import { ActivityModel, ProposalModel } from '../models/pipeline';
import { WorkOrderModel } from '../models/workOrder';
import { resetDemoData } from '../seed/reset';
import {
  ADMIN,
  DEMO_PHONE,
  FakeProvider,
  PUBLIC,
  ScriptedLlm,
  TOKEN,
  callEnv,
} from '../test/calls';
import { useTestDb } from '../test/db';
import { dialTarget, DialError, spokenDigits } from './dial';
import { placeDemoCall, TwilioCallProvider } from './provider';
import type { CallService } from './service';
import { matchStopPhrase } from './turn';

describe('vendor dispatch call', () => {
  useTestDb();
  let provider: FakeProvider;
  let woId: string;
  let vendorId: string;

  // Wednesday Nov 4 2026, 10:00 AM in Buffalo.
  const now = (): Date => new Date('2026-11-04T15:00:00Z');

  const makeApp = (llm: LlmClient = new ScriptedLlm([]), env = callEnv()) =>
    createApp(env, { callProvider: provider, callLlm: llm, now });

  beforeEach(async () => {
    await resetDemoData('propose', now());
    await CallModel.deleteMany({});
    provider = new FakeProvider();
    const wo = (await WorkOrderModel.findOne({
      status: 'dispatched',
      trade: 'plumbing',
      siteId: 'elmwood',
    }).lean())!;
    woId = wo._id;
    vendorId = wo.vendorId!;
  });

  /** Signs like Twilio does: HMAC over the exact public URL plus sorted form params. */
  function signed(app: ReturnType<typeof makeApp>, path: string, params: Record<string, string>) {
    const sig = twilio.getExpectedTwilioSignature(TOKEN, `${PUBLIC}${path}`, params);
    return request(app).post(path).type('form').set('X-Twilio-Signature', sig).send(params);
  }

  async function startCall(app: ReturnType<typeof makeApp>): Promise<{ id: string; sid: string }> {
    const res = await request(app)
      .post(`/api/work-orders/${woId}/call`)
      .set('X-Admin-Key', ADMIN)
      .expect(202);
    return { id: res.body.id, sid: res.body.callSid };
  }

  /** Answer + vendor replies, returning the TwiML of each step. */
  async function converse(
    app: ReturnType<typeof makeApp>,
    replies: string[],
  ): Promise<{ id: string; sid: string; twiml: string[] }> {
    const { id, sid } = await startCall(app);
    const twiml = [(await signed(app, `/api/twilio/voice/${id}/answer`, { CallSid: sid })).text];
    for (const [i, speech] of replies.entries()) {
      const res = await signed(app, `/api/twilio/voice/${id}/turn?n=${i + 1}`, {
        CallSid: sid,
        SpeechResult: speech,
        Confidence: '0.9',
      }).expect(200);
      twiml.push(res.text);
    }
    return { id, sid, twiml };
  }

  describe('who gets dialed', () => {
    it('dialTarget only ever returns DEMO_VENDOR_PHONE and rejects anything malformed', () => {
      expect(dialTarget({ DEMO_VENDOR_PHONE: DEMO_PHONE })).toBe(DEMO_PHONE);
      expect(() => dialTarget({ DEMO_VENDOR_PHONE: '' })).toThrow(DialError);
      expect(() => dialTarget({ DEMO_VENDOR_PHONE: '(716) 555-0141' })).toThrow(DialError);
    });

    it('placeDemoCall dials the demo number, never the vendor phone on file', async () => {
      const p = new FakeProvider();
      await placeDemoCall(
        p,
        { DEMO_VENDOR_PHONE: DEMO_PHONE, TWILIO_FROM_NUMBER: '+17165550100' },
        { answerUrl: 'a', statusCallbackUrl: 's', timeLimit: 180, ringTimeout: 25 },
      );
      expect(p.created.map((c) => c.to)).toEqual([DEMO_PHONE]);
    });

    it('starting a call dials DEMO_VENDOR_PHONE with the 180 s limit and signed webhook URLs', async () => {
      const vendor = (await VendorModel.findById(vendorId).lean())!;
      const { id } = await startCall(makeApp());
      expect(provider.created).toHaveLength(1);
      const c = provider.created[0]!;
      expect(c.to).toBe(DEMO_PHONE);
      expect(c.to).not.toBe(vendor.phone);
      expect(c.from).toBe('+17165550100');
      expect(c.timeLimit).toBe(180);
      expect(c.answerUrl).toBe(`${PUBLIC}/api/twilio/voice/${id}/answer`);
      expect(c.statusCallbackUrl).toBe(`${PUBLIC}/api/twilio/voice/${id}/status`);
      // The record never contains the dialed number.
      const record = await request(makeApp()).get(`/api/calls/${id}`).expect(200);
      expect(JSON.stringify(record.body)).not.toContain('5550199');
    });

    it('reads the callback number digit by digit', () => {
      expect(spokenDigits('+17165550100')).toBe('7 1 6, 5 5 5, 0 1 0 0');
    });
  });

  describe('gates', () => {
    it('refuses when CALLS_ENABLED is off, even with the key', async () => {
      const app = makeApp(undefined, callEnv({ CALLS_ENABLED: 'false' }));
      await request(app)
        .post(`/api/work-orders/${woId}/call`)
        .set('X-Admin-Key', ADMIN)
        .expect(403);
      expect(provider.created).toHaveLength(0);
      expect((await request(app).get('/api/calls/config')).body.enabled).toBe(false);
    });

    it('refuses without the right admin key', async () => {
      const app = makeApp();
      await request(app).post(`/api/work-orders/${woId}/call`).expect(401);
      await request(app)
        .post(`/api/work-orders/${woId}/call`)
        .set('X-Admin-Key', 'wrong')
        .expect(401);
      await request(app).post('/api/calls/verify-key').set('X-Admin-Key', 'wrong').expect(401);
      await request(app).post('/api/calls/verify-key').set('X-Admin-Key', ADMIN).expect(200);
      expect(provider.created).toHaveLength(0);
    });

    it('allows at most 6 calls per work order', async () => {
      const app = makeApp();
      for (let i = 0; i < 6; i++) {
        const { id, sid } = await startCall(app);
        await signed(app, `/api/twilio/voice/${id}/status`, {
          CallSid: sid,
          CallStatus: 'no-answer',
        });
        // A no-answer leaves the work order dispatched, so it can be called again.
      }
      const res = await request(app)
        .post(`/api/work-orders/${woId}/call`)
        .set('X-Admin-Key', ADMIN)
        .expect(429);
      expect(res.body.error).toContain('6 calls');
      expect(provider.created).toHaveLength(6);
    });

    it('allows at most 12 calls an hour across all work orders', async () => {
      const app = makeApp();
      const dispatched = await WorkOrderModel.find({ status: 'dispatched' }).lean();
      expect(dispatched.length).toBeGreaterThanOrEqual(3);
      const callWo = async (id: string, expect: number) =>
        request(app).post(`/api/work-orders/${id}/call`).set('X-Admin-Key', ADMIN).expect(expect);
      for (const wo of dispatched.slice(0, 2)) {
        for (let i = 0; i < 6; i++) {
          const res = await callWo(wo._id, 202);
          await signed(app, `/api/twilio/voice/${res.body.id}/status`, {
            CallSid: res.body.callSid,
            CallStatus: 'busy',
          });
        }
      }
      const res = await callWo(dispatched[2]!._id, 429);
      expect(res.body.error).toContain('12 per hour');
      expect(provider.created).toHaveLength(12);
    });

    it('only one call at a time, on any work order', async () => {
      const app = makeApp();
      await startCall(app);
      const other = (await WorkOrderModel.findOne({
        status: 'dispatched',
        _id: { $ne: woId },
      }).lean())!;
      const res = await request(app)
        .post(`/api/work-orders/${other._id}/call`)
        .set('X-Admin-Key', ADMIN)
        .expect(409);
      expect(res.body.error).toContain('one at a time');
    });

    it('placements Twilio refuses never count toward the hourly limit', async () => {
      const refusing = new FakeProvider();
      refusing.create = async () => {
        throw new Error('Invalid or disallowed parameters provided');
      };
      const app = createApp(callEnv(), {
        callProvider: refusing,
        callLlm: new ScriptedLlm([]),
        now,
      });
      for (let i = 0; i < 4; i++) {
        await request(app)
          .post(`/api/work-orders/${woId}/call`)
          .set('X-Admin-Key', ADMIN)
          .expect(502);
      }
      expect(await CallModel.countDocuments({ endedReason: 'failed' })).toBe(4);
      await startCall(makeApp());
      expect(provider.created).toHaveLength(1);
    });

    it('TwilioCallProvider retries with the basic parameters when a trial account refuses the rest', async () => {
      const twilioProvider = new TwilioCallProvider('AC' + '0'.repeat(32), TOKEN);
      const sent: Record<string, unknown>[] = [];
      (twilioProvider as unknown as { client: unknown }).client = {
        calls: {
          create: async (params: Record<string, unknown>) => {
            sent.push(params);
            if ('timeLimit' in params) {
              throw new Error(
                'Invalid or disallowed parameters provided - trial accounts have limited parameter access',
              );
            }
            return { sid: 'CA1' };
          },
        },
      };
      const res = await placeDemoCall(twilioProvider, callEnv(), {
        answerUrl: 'https://x/answer',
        statusCallbackUrl: 'https://x/status',
        timeLimit: 180,
        ringTimeout: 25,
      });
      expect(res.sid).toBe('CA1');
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual({
        to: DEMO_PHONE,
        from: callEnv().TWILIO_FROM_NUMBER,
        url: 'https://x/answer',
        method: 'POST',
        statusCallback: 'https://x/status',
        statusCallbackMethod: 'POST',
      });
    });

    it('only calls dispatched work orders, one call at a time', async () => {
      const app = makeApp();
      await startCall(app);
      await request(app)
        .post(`/api/work-orders/${woId}/call`)
        .set('X-Admin-Key', ADMIN)
        .expect(409);
      const closed = (await WorkOrderModel.findOne({ status: 'completed' }).lean())!;
      await request(app)
        .post(`/api/work-orders/${closed._id}/call`)
        .set('X-Admin-Key', ADMIN)
        .expect(409);
    });
  });

  describe('Twilio signature', () => {
    it('rejects a missing or wrong signature with 403', async () => {
      const app = makeApp();
      const { id, sid } = await startCall(app);
      const path = `/api/twilio/voice/${id}/answer`;
      await request(app).post(path).type('form').send({ CallSid: sid }).expect(403);
      await request(app)
        .post(path)
        .type('form')
        .set('X-Twilio-Signature', 'bm90LWEtc2lnbmF0dXJl')
        .send({ CallSid: sid })
        .expect(403);
    });

    it('rejects a signature made for different params or a different URL', async () => {
      const app = makeApp();
      const { id, sid } = await startCall(app);
      const path = `/api/twilio/voice/${id}/turn?n=1`;
      const sig = twilio.getExpectedTwilioSignature(TOKEN, `${PUBLIC}${path}`, {
        CallSid: sid,
        SpeechResult: 'yes',
      });
      await request(app)
        .post(path)
        .type('form')
        .set('X-Twilio-Signature', sig)
        .send({ CallSid: sid, SpeechResult: 'no' })
        .expect(403);
      const otherUrl = twilio.getExpectedTwilioSignature(TOKEN, `http://localhost${path}`, {
        CallSid: sid,
      });
      await request(app)
        .post(path)
        .type('form')
        .set('X-Twilio-Signature', otherUrl)
        .send({ CallSid: sid })
        .expect(403);
    });

    it('accepts a valid signature and opens with the disclosure line', async () => {
      const app = makeApp();
      const { id, sid } = await startCall(app);
      const res = await signed(app, `/api/twilio/voice/${id}/answer`, { CallSid: sid }).expect(200);
      expect(res.type).toBe('text/xml');
      expect(res.text).toContain(
        'Hi there, this is an automated assistant calling for Harbor and Hearth Kitchen.',
      );
      expect(res.text).toContain(
        'our number is 7 1 6, 5 5 5, 0 1 0 0, and you can say stop anytime.',
      );
      expect(res.text).toContain('you can say stop anytime');
      expect(res.text).toContain('Is this Lakeshore Plumbing?');
      expect(res.text).toMatch(/<Gather[^>]*input="speech"/);
      expect(res.text).toContain('voice="Google.en-US-Chirp3-HD-Aoede"');
    });
  });

  describe('turns', () => {
    it('confirm: brief, read-back, yes → accepted with ETA; replayed webhooks change nothing', async () => {
      const llm = new ScriptedLlm([
        { say: 'Great, thanks.' },
        { say: 'Tomorrow at 9.', arrivalTime: '2026-11-05T09:00' },
        { say: 'Confirmed.', action: 'confirm_job', arrivalTime: '2026-11-05T09:00' },
      ]);
      const app = makeApp(llm);
      const { id, sid, twiml } = await converse(app, [
        'Yes, this is Lakeshore.',
        'Sure, I can be there tomorrow at 9.',
        'Yes, that works.',
      ]);
      expect(twiml[1]).toContain("We've got a job at our Elmwood location");
      expect(twiml[1]).toContain('Our limit on this one is');
      expect(twiml[1]).toContain("what's the soonest you could get someone out there?");
      expect(twiml[2]).toContain("Okay, so you'd be there tomorrow at 9 AM, right?");
      expect(twiml[3]).toContain("Perfect, you're all set for tomorrow at 9 AM.");
      expect(twiml[3]).toContain('<Hangup/>');

      const wo = (await WorkOrderModel.findById(woId).lean())!;
      expect(wo.status).toBe('accepted');
      expect(wo.eta?.toISOString()).toBe('2026-11-05T14:00:00.000Z');
      const call = (await CallModel.findById(id).lean())!;
      expect(call.outcome).toBe('confirmed');
      expect(call.transcript.filter((t) => t.speaker === 'vendor')).toHaveLength(3);
      expect(call.summary).toMatch(/Vendor confirmed; arriving Thu, Nov 5, 9:00 AM/);

      // Twilio retries the last webhook and sends the final status twice.
      const replay = await signed(app, `/api/twilio/voice/${id}/turn?n=3`, {
        CallSid: sid,
        SpeechResult: 'Yes, that works.',
      });
      expect(replay.text).toBe(twiml[3]);
      for (let i = 0; i < 2; i++) {
        await signed(app, `/api/twilio/voice/${id}/status`, {
          CallSid: sid,
          CallStatus: 'completed',
          CallDuration: '42',
        }).expect(204);
      }
      const after = (await CallModel.findById(id).lean())!;
      expect(after.transcript).toHaveLength(call.transcript.length);
      expect(after).toMatchObject({ status: 'ended', durationSec: 42, outcome: 'confirmed' });
      expect(llm.calls).toHaveLength(3);
      const logs = await ActivityModel.find({ workOrderId: woId, step: 'call', actor: 'system' });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.outputSummary).toContain('dispatched → accepted');
    });

    it('confirm_job without a read-back is turned into a read-back', async () => {
      const llm = new ScriptedLlm([
        { say: 'Thanks.' },
        { say: 'Confirmed for 2.', action: 'confirm_job', arrivalTime: '2026-11-04T14:00' },
      ]);
      const app = makeApp(llm);
      const { id, twiml } = await converse(app, ['Yes.', 'I can come today at 2 pm.']);
      expect(twiml[2]).toContain("Okay, so you'd be there today at 2 PM, right?");
      expect((await CallModel.findById(id).lean())!.outcome).toBeNull();
      expect((await WorkOrderModel.findById(woId).lean())!.status).toBe('dispatched');
    });

    it('decline: work order back to approved, reassign proposal for vendor #2; approving it redispatches', async () => {
      const llm = new ScriptedLlm([
        { say: 'Great, thanks.' },
        {
          say: "Understood, thanks anyway. We'll find someone else. Goodbye.",
          action: 'decline_job',
          reason: 'Fully booked this week',
        },
      ]);
      const app = makeApp(llm);
      const { id } = await converse(app, [
        'Yes, speaking.',
        "Sorry, we're fully booked this week.",
      ]);

      const wo = (await WorkOrderModel.findById(woId).lean())!;
      expect(wo.status).toBe('approved');
      expect(wo.vendorId).toBeNull();
      expect(wo.dispatchEmail).toBeNull();
      expect(wo.declinedVendorIds).toEqual([vendorId]);
      const call = (await CallModel.findById(id).lean())!;
      expect(call.outcome).toBe('declined');
      const p = (await ProposalModel.findById(call.reassignProposalId).lean())!;
      expect(p).toMatchObject({ action: 'reassign', status: 'proposed', needsHuman: false });
      expect(p.reassign).toMatchObject({ workOrderId: woId, previousVendorId: vendorId });
      expect(p.reassign?.reason).toBe('Fully booked this week');
      expect(p.draft.vendorId).toBeTruthy();
      expect(p.draft.vendorId).not.toBe(vendorId);
      expect(p.vendors.map((v) => v.vendorId)).not.toContain(vendorId);

      // Re-applying the outcome doesn't create a second proposal.
      await app.locals.calls.applyOutcome(id);
      expect(await ProposalModel.countDocuments({ action: 'reassign' })).toBe(1);

      // The declined vendor can't be picked back.
      await request(app).post(`/api/proposals/${p._id}/approve`).send({ vendorId }).expect(409);
      const res = await request(app).post(`/api/proposals/${p._id}/approve`).send({}).expect(201);
      expect(res.body.workOrder).toMatchObject({
        id: woId,
        status: 'dispatched',
        vendorId: p.draft.vendorId,
      });
      expect(res.body.workOrder.dispatchEmail.to).toMatch(/@/);
      // Approving again is a no-op.
      await request(app).post(`/api/proposals/${p._id}/approve`).send({}).expect(200);
    });

    it('request_callback: stores the time and reason, work order stays dispatched', async () => {
      const llm = new ScriptedLlm([
        { say: 'Great.' },
        {
          say: "No problem, we'll call back then. Goodbye.",
          action: 'request_callback',
          arrivalTime: '2026-11-04T15:00',
          reason: 'Wants a call after lunch',
        },
      ]);
      const app = makeApp(llm);
      const { id } = await converse(app, ['Yes.', 'Can you call me back at 3 pm? I am on a job.']);
      const call = (await CallModel.findById(id).lean())!;
      expect(call.outcome).toBe('callback_requested');
      expect(call.callbackAt?.toISOString()).toBe('2026-11-04T20:00:00.000Z');
      expect(call.reason).toBe('Wants a call after lunch');
      expect((await WorkOrderModel.findById(woId).lean())!.status).toBe('dispatched');
    });

    it('end: model ends the call; email fallback recorded', async () => {
      const llm = new ScriptedLlm([
        { say: 'Sorry about that. Goodbye.', action: 'end', reason: 'Wrong person' },
      ]);
      const app = makeApp(llm);
      const { id, twiml } = await converse(app, ['No, this is a bakery.']);
      expect(twiml[1]).toContain('<Hangup/>');
      const call = (await CallModel.findById(id).lean())!;
      expect(call.outcome).toBe('ended');
      const log = (await ActivityModel.findOne({
        workOrderId: woId,
        step: 'call',
        actor: 'system',
      }))!;
      expect(log.outputSummary).toContain('Email fallback used');
    });

    it('enforces the 180 s limit itself: ends at the next turn and hangs up a call left open', async () => {
      const app = makeApp(new ScriptedLlm([]));
      const { id, sid } = await converse(app, []);
      await CallModel.updateOne(
        { _id: id },
        { 'transcript.0.at': new Date(now().getTime() - 181_000) },
      );
      const res = await signed(app, `/api/twilio/voice/${id}/turn?n=1`, {
        CallSid: sid,
        SpeechResult: 'Hang on, let me check.',
      }).expect(200);
      expect(res.text).toContain('<Hangup/>');
      const call = (await CallModel.findById(id).lean())!;
      expect(call.outcome).toBe('email_fallback');
      expect(call.reason).toBe('Call time limit reached');

      // The timer path: a call still open (no endedAt) is hung up through the provider.
      await (app.locals.calls as CallService).enforceTimeLimit(id);
      expect(provider.hungUp).toEqual([sid]);
      await signed(app, `/api/twilio/voice/${id}/status`, {
        CallSid: sid,
        CallStatus: 'completed',
      });
      await (app.locals.calls as CallService).enforceTimeLimit(id);
      expect(provider.hungUp).toEqual([sid]);
    });

    it('stop phrases end the call before the model is asked', async () => {
      const llm = new ScriptedLlm([]);
      const app = makeApp(llm);
      const { id, twiml } = await converse(app, ["Please don't call this number."]);
      expect(twiml[1]).toContain("We won't call again about this one. Bye now.");
      expect(twiml[1]).toContain('<Hangup/>');
      expect(llm.calls).toHaveLength(0);
      expect((await CallModel.findById(id).lean())!.outcome).toBe('opted_out');
    });

    it.each([
      ['stop', 'stop'],
      ['Not interested, thanks.', 'not interested'],
      ['You have the wrong number', 'wrong number'],
      ['Remove me from your list', 'remove me'],
      ['No thanks.', 'no thanks'],
      ['I can stop by tomorrow at 9', null],
      ['Yes this is Lakeshore', null],
    ])('matchStopPhrase(%s)', (speech, expected) => {
      expect(matchStopPhrase(speech)).toBe(expected);
    });

    it('no speech: re-asks once, then ends with the email fallback', async () => {
      const app = makeApp();
      const { id, twiml } = await converse(app, ['', '']);
      expect(twiml[1]).toContain("Sorry, I didn't catch that.");
      expect(twiml[1]).toContain('Is this Lakeshore Plumbing?');
      expect(twiml[2]).toContain("we'll follow up by email");
      expect(twiml[2]).toContain('<Hangup/>');
      expect((await CallModel.findById(id).lean())!.outcome).toBe('email_fallback');
    });

    it('model timeout: says "one moment" and retries once with the same speech', async () => {
      const llm = new ScriptedLlm([
        new LlmError('LLM call failed: Request timed out.', true),
        { say: 'Great, thanks.' },
      ]);
      const app = makeApp(llm);
      const { id, sid, twiml } = await converse(app, ['Yes, this is Lakeshore.']);
      expect(twiml[1]).toContain('Sorry, just one sec.');
      expect(twiml[1]).toContain(`/api/twilio/voice/${id}/turn?n=2&amp;retry=1`);
      const retry = await signed(app, `/api/twilio/voice/${id}/turn?n=2&retry=1`, {
        CallSid: sid,
      }).expect(200);
      expect(retry.text).toContain("We've got a job at our");
      expect(llm.calls.map((c) => c.user.includes('Yes, this is Lakeshore.'))).toEqual([
        true,
        true,
      ]);
      const call = (await CallModel.findById(id).lean())!;
      expect(call.transcript.filter((t) => t.speaker === 'vendor')).toHaveLength(1);
    });

    it('model fails twice: ends politely with the email fallback', async () => {
      const llm = new ScriptedLlm([
        new LlmError('LLM call failed: Request timed out.', true),
        new LlmError('LLM call failed: Request timed out.', true),
      ]);
      const app = makeApp(llm);
      const { id, sid } = await converse(app, ['Yes.']);
      const retry = await signed(app, `/api/twilio/voice/${id}/turn?n=2&retry=1`, { CallSid: sid });
      expect(retry.text).toContain("We'll follow up by email. Bye now.");
      expect((await CallModel.findById(id).lean())!.outcome).toBe('email_fallback');
    });

    it('escalates to the big model only when the small model output fails validation', async () => {
      const llm = new ScriptedLlm([
        new LlmError('Model output failed validation: say too long', false),
        { say: 'Great, thanks.' },
      ]);
      const app = makeApp(llm);
      const { id } = await converse(app, ['Yes.']);
      expect(llm.calls.map((c) => c.model)).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
      expect(llm.calls.every((c) => (c.maxTokens ?? 0) > 0)).toBe(true);
      const agent = (await CallModel.findById(id).lean())!.transcript.at(-1)!;
      expect(agent.model).toBe('openai/gpt-oss-120b');
    });

    it('wraps up after 6 vendor turns without a decision', async () => {
      const llm = new ScriptedLlm(
        Array.from({ length: 6 }, (_, i) => ({ say: i === 0 ? 'Thanks.' : 'Could you say more?' })),
      );
      const app = makeApp(llm);
      const { id, twiml } = await converse(app, [
        'Yes.',
        'Hmm.',
        'Well.',
        'Maybe.',
        'Not sure.',
        'Hm.',
      ]);
      expect(twiml[6]).toContain('Our manager will follow up by email. Bye now.');
      const call = (await CallModel.findById(id).lean())!;
      expect(call).toMatchObject({ outcome: 'ended', vendorTurns: 6 });
    });
  });

  describe('status callback', () => {
    it('no-answer → email fallback, logged once; out-of-order events never move status back', async () => {
      const app = makeApp();
      const { id, sid } = await startCall(app);
      const status = (s: string) =>
        signed(app, `/api/twilio/voice/${id}/status`, { CallSid: sid, CallStatus: s }).expect(204);
      await status('ringing');
      expect((await CallModel.findById(id).lean())!.status).toBe('ringing');
      await status('no-answer');
      await status('ringing');
      await status('no-answer');
      const call = (await CallModel.findById(id).lean())!;
      expect(call).toMatchObject({
        status: 'ended',
        outcome: 'email_fallback',
        reason: 'No answer',
        endedReason: 'no-answer',
      });
      const logs = await ActivityModel.find({ workOrderId: woId, step: 'call', actor: 'system' });
      expect(logs).toHaveLength(1);
      expect((await WorkOrderModel.findById(woId).lean())!.status).toBe('dispatched');
    });

    it('answered but silent (voicemail or trial notice not passed) → email fallback', async () => {
      const app = makeApp();
      const { id, sid } = await startCall(app);
      await signed(app, `/api/twilio/voice/${id}/answer`, { CallSid: sid });
      await signed(app, `/api/twilio/voice/${id}/status`, {
        CallSid: sid,
        CallStatus: 'completed',
        CallDuration: '12',
      });
      const call = (await CallModel.findById(id).lean())!;
      expect(call.outcome).toBe('email_fallback');
      expect(call.reason).toMatch(/No speech/);
    });

    it('a webhook for another CallSid is ignored', async () => {
      const app = makeApp();
      const { id } = await startCall(app);
      const res = await signed(app, `/api/twilio/voice/${id}/answer`, { CallSid: 'CAother' });
      expect(res.text).not.toContain('Gather');
    });
  });

  it('demo reset keeps call records', async () => {
    const app = makeApp();
    const { id } = await startCall(app);
    await resetDemoData('propose', now());
    expect(await CallModel.exists({ _id: id })).toBeTruthy();
  });
});
