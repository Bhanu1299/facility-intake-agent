import { createHash, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import type { CallAction, CallOutcome, Urgency } from '@fia/shared';
import { logActivity } from '../activity';
import type { Env } from '../env';
import { newId } from '../ids';
import type { LlmClient } from '../llm/client';
import { CallModel, type CallDoc } from '../models/call';
import { SiteModel, VendorModel } from '../models/catalog';
import { WorkOrderModel } from '../models/workOrder';
import { SITE_TIME_ZONE, URGENCY_WINDOW_HOURS } from '../pipeline/plan';
import { COMPANY_NAME } from '../seed/data';
import { proposeNextVendor } from '../workflow/reassign';
import { DialError, spokenDigits } from './dial';
import { placeDemoCall, type CallProvider } from './provider';
import { formatSpokenTime, localIsoToUtc, parseSpokenArrival } from './time';
import { decideTurn, matchStopPhrase, type CallJob, type TurnModels } from './turn';

export const MAX_CALLS_PER_HOUR = 3;
export const CALL_TIME_LIMIT_SEC = 180;
export const RING_TIMEOUT_SEC = 25;
/** Vendor utterances the model handles before the agent wraps up. */
export const MAX_VENDOR_TURNS = 6;
/** One voice for every line. https://www.twilio.com/docs/voice/twiml/say/text-speech */
export const VOICE = 'Polly.Joanna-Neural';

export class CallError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503,
  ) {
    super(message);
  }
}

/** Company name as spoken ("Harbor and Hearth Kitchen"). */
const SPOKEN_COMPANY = COMPANY_NAME.replace(/&/g, 'and');

const URGENCY_WORD: Record<Urgency, string> = {
  emergency: 'an emergency',
  urgent: 'urgent',
  routine: 'routine',
  low: 'low priority',
};

function windowText(urgency: Urgency): string {
  const h = URGENCY_WINDOW_HOURS[urgency];
  return h < 48 ? `within ${h} hours` : `within ${h / 24} days`;
}

/** "WO-1234" -> "1 2 3 4" so it is read digit by digit. */
const spokenWorkOrder = (number: string): string => number.replace(/\D/g, '').split('').join(' ');

const firstWords = (s: string, n: number): string => s.split(/\s+/).slice(0, n).join(' ');

const sameMinute = (a: Date, b: Date): boolean =>
  Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);

const DAY_MS = 86_400_000;

/** Lines spoken before the first question: the required disclosure, always first. */
export function openingLines(env: Pick<Env, 'TWILIO_FROM_NUMBER'>): string[] {
  return [
    `Hi, this is an automated assistant calling on behalf of ${SPOKEN_COMPANY} about a maintenance job.`,
    `Our callback number is ${spokenDigits(env.TWILIO_FROM_NUMBER)}.`,
    'Say stop at any time to end the call.',
  ];
}

export function briefLines(job: CallJob, shortSite: string): string[] {
  return [
    `This is work order ${spokenWorkOrder(job.workOrderNumber)}: ${firstWords(job.title, 10)}, at our ${shortSite} location, ${job.siteAddress}.`,
    `It's ${URGENCY_WORD[job.urgency]}, needed ${job.window}. The not-to-exceed amount is ${job.nte} dollars.`,
  ];
}

export const BRIEF_QUESTION = "Can you take this job, and what's the earliest you can arrive?";

interface TurnPlan {
  says: string[];
  /** Asked inside <Gather>; null = no more input on this response. */
  question: string | null;
  /** Say "one moment" and come back for a second model try. */
  redirectRetry?: boolean;
  hangup?: boolean;
  outcome?: CallOutcome;
  reason?: string | null;
  eta?: Date | null;
  callbackAt?: Date | null;
  set?: Partial<
    Pick<
      CallDoc,
      | 'noSpeechCount'
      | 'llmFailures'
      | 'vendorTurns'
      | 'briefRead'
      | 'pendingArrival'
      | 'pendingSpeech'
    >
  >;
  model?: string | null;
  latencyMs?: number | null;
  action?: CallAction | null;
}

type WebhookBody = Record<string, unknown>;

export interface CallServiceDeps {
  env: Env;
  /** Null when Twilio isn't configured. */
  provider: CallProvider | null;
  llm: LlmClient;
  models: TurnModels;
  now?: () => Date;
}

/** Vendor dispatch phone call: Twilio <Say>/<Gather> turns, one Groq call per vendor reply. */
export class CallService {
  private readonly env: Env;
  private readonly now: () => Date;

  constructor(private readonly deps: CallServiceDeps) {
    this.env = deps.env;
    this.now = deps.now ?? (() => new Date());
  }

  /** All settings present (whether or not CALLS_ENABLED is on). */
  isConfigured(): boolean {
    const e = this.env;
    return Boolean(
      this.deps.provider &&
      e.TWILIO_AUTH_TOKEN &&
      e.TWILIO_FROM_NUMBER &&
      e.DEMO_VENDOR_PHONE &&
      e.CALL_ADMIN_KEY &&
      e.PUBLIC_API_URL,
    );
  }

  enabled(): boolean {
    return this.env.CALLS_ENABLED && this.isConfigured();
  }

  checkAdminKey(key: string | undefined): boolean {
    if (!this.env.CALL_ADMIN_KEY || !key) return false;
    const digest = (s: string) => createHash('sha256').update(s).digest();
    return timingSafeEqual(digest(key), digest(this.env.CALL_ADMIN_KEY));
  }

  private webhookBase(callId: string): string {
    return `${this.env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/twilio/voice/${callId}`;
  }

  /** POST /api/work-orders/:id/call. Gated by CALLS_ENABLED + the admin key, 3 calls an hour. */
  async start(workOrderId: string, adminKey: string | undefined): Promise<CallDoc> {
    if (!this.env.CALLS_ENABLED) throw new CallError('Vendor calls are disabled', 403);
    if (!this.checkAdminKey(adminKey)) throw new CallError('Admin key required', 401);
    if (!this.isConfigured() || !this.deps.provider) {
      throw new CallError('Vendor calls are not configured on this server', 503);
    }
    const wo = await WorkOrderModel.findById(workOrderId).lean();
    if (!wo) throw new CallError('Work order not found', 404);
    if (wo.status !== 'dispatched' || !wo.vendorId) {
      throw new CallError(
        `Only dispatched work orders can be called (this one is ${wo.status})`,
        409,
      );
    }
    const now = this.now();
    const active = await CallModel.exists({
      workOrderId,
      endedAt: null,
      createdAt: { $gt: new Date(now.getTime() - (CALL_TIME_LIMIT_SEC + 120) * 1000) },
    });
    if (active) throw new CallError('A call for this work order is already in progress', 409);
    const hourAgo = new Date(now.getTime() - 3600_000);
    // Placements Twilio refused never rang, so they don't count toward the limit.
    const recent = { createdAt: { $gt: hourAgo }, endedReason: { $ne: 'failed' } };
    if ((await CallModel.countDocuments(recent)) >= MAX_CALLS_PER_HOUR) {
      throw new CallError(`Call limit reached (${MAX_CALLS_PER_HOUR} per hour). Try later.`, 429);
    }
    const [vendor, site] = await Promise.all([
      VendorModel.findById(wo.vendorId).lean(),
      SiteModel.findById(wo.siteId).lean(),
    ]);
    if (!vendor || !site) throw new CallError('Vendor or site not found', 409);

    const id = newId('call');
    await CallModel.create({
      _id: id,
      callSid: null,
      workOrderId,
      workOrderNumber: wo.number,
      workOrderTitle: wo.title,
      vendorId: vendor._id,
      vendorName: vendor.name,
      siteName: site.name,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });
    // Two concurrent starts can both pass the count above; re-count with ours included.
    if ((await CallModel.countDocuments(recent)) > MAX_CALLS_PER_HOUR) {
      await CallModel.deleteOne({ _id: id });
      throw new CallError(`Call limit reached (${MAX_CALLS_PER_HOUR} per hour). Try later.`, 429);
    }

    try {
      const base = this.webhookBase(id);
      const { sid } = await placeDemoCall(this.deps.provider, this.env, {
        answerUrl: `${base}/answer`,
        statusCallbackUrl: `${base}/status`,
        timeLimit: CALL_TIME_LIMIT_SEC,
        ringTimeout: RING_TIMEOUT_SEC,
      });
      await CallModel.updateOne(
        { _id: id },
        { callSid: sid, twilioStatus: 'queued', updatedAt: this.now() },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await CallModel.updateOne(
        { _id: id },
        {
          status: 'ended',
          outcome: 'email_fallback',
          reason: `Call could not be placed: ${msg}`.slice(0, 300),
          endedReason: 'failed',
          endedAt: this.now(),
          updatedAt: this.now(),
        },
      );
      await this.applyOutcome(id);
      throw new CallError(
        err instanceof DialError ? msg : 'Twilio could not place the call; email fallback used',
        502,
      );
    }
    await logActivity({
      step: 'call',
      actor: 'manager',
      workOrderId,
      inputSummary: `Call ${vendor.name} about ${wo.number}`,
      outputSummary: 'Dispatch call started (demo number only)',
    });
    return (await CallModel.findById(id).lean())!;
  }

  private render(callId: string, n: number, plan: TurnPlan): string {
    const r = new twilio.twiml.VoiceResponse();
    const say = { voice: VOICE, language: 'en-US' } as const;
    for (const line of plan.says) r.say(say, line);
    if (plan.question) {
      // https://www.twilio.com/docs/voice/twiml/gather
      const g = r.gather({
        input: ['speech'],
        action: `${this.webhookBase(callId)}/turn?n=${n + 1}`,
        method: 'POST',
        speechTimeout: 'auto',
        timeout: 6,
        language: 'en-US',
        hints: 'yes, no, today, tomorrow, morning, afternoon, a.m., p.m., stop, call back',
        actionOnEmptyResult: true,
      });
      g.say(say, plan.question);
    } else if (plan.redirectRetry) {
      r.redirect({ method: 'POST' }, `${this.webhookBase(callId)}/turn?n=${n + 1}&retry=1`);
    }
    if (plan.hangup) r.hangup();
    return r.toString();
  }

  /** Answer webhook (sequence 0): disclosure, then "Am I speaking with <vendor>?". */
  async answer(callId: string, body: WebhookBody): Promise<string> {
    const call = await CallModel.findById(callId).lean();
    if (!call || !sidMatches(call, body)) return hangupTwiml();
    if (call.responses['0']) return call.responses['0'];
    const question = `Am I speaking with ${call.vendorName}?`;
    const plan: TurnPlan = { says: openingLines(this.env), question };
    const xml = this.render(callId, 0, plan);
    const now = this.now();
    const res = await CallModel.updateOne(
      { _id: callId, seq: -1 },
      {
        $set: {
          seq: 0,
          'responses.0': xml,
          lastQuestion: question,
          status: 'in_call',
          callSid: call.callSid ?? stringOrNull(body.CallSid),
          updatedAt: now,
        },
        $push: {
          transcript: {
            n: 0,
            speaker: 'agent',
            text: [...plan.says, question].join(' '),
            at: now,
            confidence: null,
            latencyMs: null,
            model: null,
            action: null,
          },
        },
      },
    );
    if (res.modifiedCount === 0) {
      return (await CallModel.findById(callId).lean())?.responses['0'] ?? hangupTwiml();
    }
    // Twilio's timeLimit is the main cap, but a trial account may have refused it.
    setTimeout(() => {
      void this.enforceTimeLimit(callId);
    }, CALL_TIME_LIMIT_SEC * 1000).unref();
    return xml;
  }

  /** Hangs up a call still open CALL_TIME_LIMIT_SEC after it was answered. */
  async enforceTimeLimit(callId: string): Promise<void> {
    const call = await CallModel.findById(callId).lean();
    if (!call || call.endedAt || !call.callSid || !this.deps.provider) return;
    await this.deps.provider.hangup(call.callSid).catch((err: unknown) => {
      console.error('[calls] time-limit hangup failed', err);
    });
  }

  /** Gather / redirect webhook for sequence n. Replays the stored reply if Twilio retries. */
  async turn(callId: string, n: number, retry: boolean, body: WebhookBody): Promise<string> {
    const call = await CallModel.findById(callId).lean();
    if (!call || !sidMatches(call, body)) return hangupTwiml();
    const stored = call.responses[String(n)];
    if (stored) return stored;
    if (call.outcome || call.endedAt || n !== call.seq + 1) return hangupTwiml();

    const now = this.now();
    const speech = retry
      ? (call.pendingSpeech ?? '')
      : (stringOrNull(body.SpeechResult) ?? '').trim();
    const confidence = retry ? null : numberOrNull(body.Confidence);
    const plan = await this.plan(call, speech, retry, now);
    const xml = this.render(callId, n, plan);

    const lines: CallDoc['transcript'] = [];
    if (!retry && speech) {
      lines.push({
        n,
        speaker: 'vendor',
        text: speech,
        at: now,
        confidence,
        latencyMs: null,
        model: null,
        action: null,
      });
    }
    lines.push({
      n,
      speaker: 'agent',
      text: [...plan.says, ...(plan.question ? [plan.question] : [])].join(' '),
      at: this.now(),
      confidence: null,
      latencyMs: plan.latencyMs ?? null,
      model: plan.model ?? null,
      action: plan.action ?? null,
    });
    const set: Record<string, unknown> = {
      seq: n,
      [`responses.${n}`]: xml,
      ...plan.set,
      updatedAt: this.now(),
    };
    if (plan.question) set.lastQuestion = plan.question;
    if (plan.outcome) {
      set.outcome = plan.outcome;
      set.reason = plan.reason ?? null;
      if (plan.eta !== undefined) set.eta = plan.eta;
      if (plan.callbackAt !== undefined) set.callbackAt = plan.callbackAt;
    }
    const res = await CallModel.updateOne(
      { _id: callId, seq: n - 1, outcome: null },
      { $set: set, $push: { transcript: { $each: lines } } },
    );
    if (res.modifiedCount === 0) {
      // Lost a race with a retry of the same webhook: reply the way the winner did.
      return (await CallModel.findById(callId).lean())?.responses[String(n)] ?? hangupTwiml();
    }
    if (plan.outcome) {
      await this.applyOutcome(callId).catch((err: unknown) => {
        console.error('[calls] applying outcome failed; retried on the status callback', err);
      });
    }
    return xml;
  }

  private async plan(call: CallDoc, speech: string, retry: boolean, now: Date): Promise<TurnPlan> {
    const goodbye = (says: string[], outcome: CallOutcome, reason: string | null): TurnPlan => ({
      says,
      question: null,
      hangup: true,
      outcome,
      reason,
    });

    const answeredAt = call.transcript[0]?.at;
    if (answeredAt && now.getTime() - answeredAt.getTime() >= CALL_TIME_LIMIT_SEC * 1000) {
      return goodbye(
        ["We're out of time, so the manager will follow up by email. Goodbye."],
        'email_fallback',
        'Call time limit reached',
      );
    }

    if (!speech) {
      if (call.noSpeechCount === 0) {
        return {
          says: ["Sorry, I didn't catch that."],
          question: call.lastQuestion,
          set: { noSpeechCount: 1 },
        };
      }
      return goodbye(
        ["I didn't hear anything, so we'll follow up by email. Goodbye."],
        'email_fallback',
        'No speech from the vendor',
      );
    }

    const stop = matchStopPhrase(speech);
    if (stop) {
      return goodbye(
        ["Sorry to bother you. We won't call again about this job. Goodbye."],
        'opted_out',
        `Vendor said "${stop}"`,
      );
    }

    const job = await this.jobFor(call);
    let turn;
    try {
      turn = await decideTurn(this.deps.llm, this.deps.models, {
        job: job.job,
        transcript: call.transcript.map((t) => ({ speaker: t.speaker, text: t.text })),
        vendorSaid: speech,
        briefRead: call.briefRead,
        pendingArrival: call.pendingArrival,
        now,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (call.llmFailures === 0 && !retry) {
        return {
          says: ['Sorry, one moment.'],
          question: null,
          redirectRetry: true,
          set: { llmFailures: 1, pendingSpeech: speech },
        };
      }
      return goodbye(
        ["Sorry, I'm having trouble on my end. We'll follow up by email. Goodbye."],
        'email_fallback',
        `Model unavailable: ${msg}`.slice(0, 300),
      );
    }

    const d = turn.decision;
    const meta = {
      model: turn.model,
      latencyMs: turn.latencyMs,
      action: d.action,
    };
    const vendorTurns = call.vendorTurns + 1;
    const base = { vendorTurns, pendingSpeech: null };
    const arrival = validArrival(
      parseSpokenArrival(speech, now) ?? (d.arrivalTime ? localIsoToUtc(d.arrivalTime) : null),
      now,
    );
    const readBack = (at: Date): TurnPlan => ({
      says: [],
      question: `Just to confirm, you'll arrive ${formatSpokenTime(at, now)}. Is that right?`,
      set: { ...base, pendingArrival: at },
      ...meta,
    });

    let plan: TurnPlan;
    switch (d.action) {
      case 'confirm_job': {
        const pending = call.pendingArrival;
        if (pending && (!arrival || sameMinute(arrival, pending))) {
          plan = {
            ...goodbye(
              [
                `Great, you're confirmed for ${formatSpokenTime(pending, now)}.`,
                `The work order number is ${spokenWorkOrder(call.workOrderNumber)}. Thank you, goodbye.`,
              ],
              'confirmed',
              null,
            ),
            eta: pending,
            set: base,
            ...meta,
          };
        } else if (arrival) {
          // The model can't confirm a time the vendor hasn't heard read back.
          plan = readBack(arrival);
        } else {
          plan = {
            says: [],
            question: "What's the earliest time you could arrive?",
            set: base,
            ...meta,
          };
        }
        break;
      }
      case 'continue':
        if (arrival && !(call.pendingArrival && sameMinute(arrival, call.pendingArrival))) {
          plan = readBack(arrival);
        } else if (!call.briefRead) {
          plan = {
            says: [d.say, ...briefLines(job.job, job.shortSite)],
            question: BRIEF_QUESTION,
            set: { ...base, briefRead: true },
            ...meta,
          };
        } else {
          plan = { says: [], question: d.say, set: base, ...meta };
        }
        break;
      case 'decline_job':
        plan = {
          ...goodbye([d.say], 'declined', d.reason ?? speech.slice(0, 200)),
          set: base,
          ...meta,
        };
        break;
      case 'request_callback':
        plan = {
          ...goodbye([d.say], 'callback_requested', d.reason ?? speech.slice(0, 200)),
          callbackAt: arrival,
          set: base,
          ...meta,
        };
        break;
      case 'end':
        plan = { ...goodbye([d.say], 'ended', d.reason), set: base, ...meta };
        break;
    }

    if (!plan.hangup && vendorTurns >= MAX_VENDOR_TURNS) {
      plan = {
        ...goodbye(
          ['Thanks for your time. The manager will follow up by email. Goodbye.'],
          'ended',
          'Turn limit reached without a decision',
        ),
        set: base,
        ...meta,
        action: 'end',
      };
    }
    return plan;
  }

  private async jobFor(call: CallDoc): Promise<{ job: CallJob; shortSite: string }> {
    const wo = await WorkOrderModel.findById(call.workOrderId).lean();
    const site = wo ? await SiteModel.findById(wo.siteId).lean() : null;
    const street = site ? site.address.split(',').slice(0, 2).join(',').trim() : '';
    return {
      shortSite: site?.shortName ?? call.siteName,
      job: {
        companyName: SPOKEN_COMPANY,
        vendorName: call.vendorName,
        siteName: call.siteName.replace(/&/g, 'and'),
        siteAddress: street,
        workOrderNumber: call.workOrderNumber,
        title: wo?.title ?? call.workOrderTitle,
        description: wo?.description ?? '',
        locationText: wo?.locationText ?? '',
        urgency: wo?.urgency ?? 'routine',
        window: windowText(wo?.urgency ?? 'routine'),
        nte: wo?.nte ?? 0,
      },
    };
  }

  /** statusCallback: progress (queued, ringing, in call) and the final status and duration. */
  async status(callId: string, body: WebhookBody): Promise<void> {
    const call = await CallModel.findById(callId).lean();
    if (!call || !sidMatches(call, body)) return;
    const tw = stringOrNull(body.CallStatus) ?? '';
    const now = this.now();
    const progress: Record<string, { status: CallDoc['status']; from: CallDoc['status'][] }> = {
      initiated: { status: 'queued', from: ['queued'] },
      ringing: { status: 'ringing', from: ['queued'] },
      'in-progress': { status: 'in_call', from: ['queued', 'ringing'] },
      answered: { status: 'in_call', from: ['queued', 'ringing'] },
    };
    const step = progress[tw];
    if (step) {
      // Callbacks can arrive out of order; status only moves forward.
      await CallModel.updateOne(
        { _id: callId, endedAt: null, status: { $in: step.from } },
        { status: step.status, twilioStatus: tw, updatedAt: now },
      );
      return;
    }
    if (!['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(tw)) return;

    const sip = stringOrNull(body.SipResponseCode);
    await CallModel.updateOne(
      { _id: callId, endedAt: null },
      {
        status: 'ended',
        twilioStatus: tw,
        durationSec: numberOrNull(body.CallDuration) ?? 0,
        endedReason: sip && tw !== 'completed' ? `${tw} (SIP ${sip})` : tw,
        endedAt: now,
        updatedAt: now,
      },
    );
    const spoke = call.transcript.some((t) => t.speaker === 'vendor');
    const reason: Record<string, string> = {
      'no-answer': 'No answer',
      busy: 'Line busy',
      failed: 'Call failed',
      canceled: 'Call canceled',
      completed: spoke
        ? 'Call ended before a decision'
        : 'No speech (voicemail, trial notice not passed, or hang-up)',
    };
    await CallModel.updateOne(
      { _id: callId, outcome: null },
      { outcome: 'email_fallback', reason: reason[tw] ?? tw, updatedAt: now },
    );
    await this.applyOutcome(callId);
  }

  /** Work order, proposal and Activity Log effects of an outcome. Runs once per call. */
  async applyOutcome(callId: string): Promise<void> {
    const now = this.now();
    const call = await CallModel.findOneAndUpdate(
      { _id: callId, outcome: { $ne: null }, outcomeAppliedAt: null },
      { outcomeAppliedAt: now },
      { new: true },
    ).lean();
    if (!call) return;
    try {
      const summary = summarize(call);
      let reassignProposalId: string | null = null;
      let output = summary;
      if (call.outcome === 'confirmed' && call.eta) {
        const res = await WorkOrderModel.updateOne(
          { _id: call.workOrderId, status: 'dispatched', vendorId: call.vendorId },
          { status: 'accepted', eta: call.eta, updatedAt: now },
        );
        output =
          res.modifiedCount === 1
            ? `Status dispatched → accepted. ${summary}`
            : `Work order was no longer dispatched to this vendor; nothing changed. ${summary}`;
      } else if (call.outcome === 'declined') {
        reassignProposalId = await proposeNextVendor(call, now);
      } else if (call.outcome !== 'callback_requested') {
        output = `Email fallback used: the dispatch email draft is the record. ${summary}`;
      }
      await CallModel.updateOne({ _id: callId }, { summary, reassignProposalId, updatedAt: now });
      await logActivity({
        step: 'call',
        actor: 'system',
        workOrderId: call.workOrderId,
        proposalId: reassignProposalId,
        inputSummary: `Call to ${call.vendorName} about ${call.workOrderNumber}: ${call.outcome}`,
        outputSummary: output,
        reason: call.reason,
      });
    } catch (err) {
      await CallModel.updateOne({ _id: callId }, { outcomeAppliedAt: null });
      throw err;
    }
  }
}

function validArrival(at: Date | null, now: Date): Date | null {
  if (!at || Number.isNaN(at.getTime())) return null;
  return at > now && at.getTime() - now.getTime() < 30 * DAY_MS ? at : null;
}

const etaText = (d: Date): string =>
  d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: SITE_TIME_ZONE,
  });

/** One-line transcript summary for the Activity Log and the work order panel. */
export function summarize(
  call: Pick<CallDoc, 'outcome' | 'eta' | 'callbackAt' | 'reason' | 'transcript'>,
): string {
  const head: Record<CallOutcome, string> = {
    confirmed: `Vendor confirmed; arriving ${call.eta ? etaText(call.eta) : 'at an unknown time'}.`,
    declined: `Vendor declined${call.reason ? `: ${call.reason}` : ''}.`,
    callback_requested: `Vendor asked for a callback${call.callbackAt ? ` ${etaText(call.callbackAt)}` : ''}${call.reason ? `: ${call.reason}` : ''}.`,
    opted_out: 'Vendor asked not to be called; call ended.',
    ended: `Call ended without a decision${call.reason ? ` (${call.reason})` : ''}.`,
    email_fallback: `No conversation${call.reason ? ` (${call.reason})` : ''}.`,
  };
  const vendor = call.transcript.filter((t) => t.speaker === 'vendor').map((t) => t.text);
  const quoted = vendor.slice(-2).map((t) => `"${t.length > 80 ? `${t.slice(0, 79)}…` : t}"`);
  return [
    head[call.outcome ?? 'email_fallback'],
    quoted.length ? `Vendor said: ${quoted.join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const hangupTwiml = (): string => {
  const r = new twilio.twiml.VoiceResponse();
  r.hangup();
  return r.toString();
};

const stringOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numberOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Webhooks name the call in the URL; the CallSid in the signed body must agree. */
function sidMatches(call: Pick<CallDoc, 'callSid'>, body: WebhookBody): boolean {
  const sid = stringOrNull(body.CallSid);
  return !call.callSid || !sid || sid === call.callSid;
}
