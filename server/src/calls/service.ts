import { createHash, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import type {
  CallAction,
  CallOutcome,
  CallPurpose,
  QuoteResult,
  QuoteTurnDecision,
  Urgency,
} from '@fia/shared';
import { estimateCeiling, formatEstimate } from '@fia/shared';
import { logActivity } from '../activity';
import type { Env } from '../env';
import { newId } from '../ids';
import type { LlmClient } from '../llm/client';
import { CallModel, type CallDoc } from '../models/call';
import { SiteModel, VendorModel } from '../models/catalog';
import { SettingsModel } from '../models/settings';
import { WorkOrderModel } from '../models/workOrder';
import { SITE_TIME_ZONE, URGENCY_WINDOW_HOURS } from '../pipeline/plan';
import { COMPANY_NAME } from '../seed/data';
import { proposeNextVendor } from '../workflow/reassign';
import { DialError, spokenDigits } from './dial';
import { placeDemoCall, type CallProvider } from './provider';
import { formatSpokenTime, localIsoToUtc, parseSpokenArrival } from './time';
import {
  decideQuoteTurn,
  finalizeQuote,
  isPlainYes,
  normalizeEstimate,
  overNte,
  spokenEstimate,
} from './quote';
import { decideTurn, matchStopPhrase, type CallJob, type ModelTurn, type TurnModels } from './turn';

export const MAX_CALLS_PER_HOUR = 12;
export const MAX_CALLS_PER_WORK_ORDER = 6;
export const CALL_TIME_LIMIT_SEC = 180;
export const RING_TIMEOUT_SEC = 25;
/** Vendor utterances the model handles before the agent wraps up. */
export const MAX_VENDOR_TURNS = 6;
/** Quote calls ask more questions (estimate, arrival, read-back, limit). */
export const MAX_QUOTE_TURNS = 9;
/** A call still open this long after it was created has lost its final status callback. */
export const STALE_CALL_MS = (CALL_TIME_LIMIT_SEC + RING_TIMEOUT_SEC + 120) * 1000;
/** One voice for every line. https://www.twilio.com/docs/voice/twiml/say/text-speech */

export class CallError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503,
    /** Lets the chain scheduler tell "try later" apart from "give up". */
    readonly code?: 'busy' | 'hourly_cap' | 'work_order_cap',
  ) {
    super(message);
  }
}

export interface PlaceCallInput {
  workOrderId: string;
  vendorId: string;
  purpose: CallPurpose;
  chainId: string | null;
  actor: 'manager' | 'system';
  /** Fixed id for scheduler jobs, so running a job twice never places two calls. */
  callId?: string;
  /** Booking a quote winner: their quote, mentioned on the call and stored on confirm. */
  bookingQuote?: QuoteResult | null;
}

/** Company name as spoken ("Harbor and Hearth Kitchen"). */
const SPOKEN_COMPANY = COMPANY_NAME.replace(/&/g, 'and');

/** How a person would say the urgency, followed by the window ("within 5 days"). */
const URGENCY_PHRASE: Record<Urgency, string> = {
  emergency: "It's an emergency, so we'd need someone",
  urgent: "It's pretty urgent, so we'd need someone",
  routine: 'Nothing urgent, anytime',
  low: 'No rush at all, anytime',
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
    `Hi there, this is an automated assistant calling for ${SPOKEN_COMPANY}.`,
    `If you need to reach us, our number is ${spokenDigits(env.TWILIO_FROM_NUMBER)}, and you can say stop anytime.`,
  ];
}

export function briefLines(job: CallJob, shortSite: string): string[] {
  return [
    `We've got a job at our ${shortSite} location, ${job.siteAddress}. ${firstWords(job.title, 10)}.`,
    `${URGENCY_PHRASE[job.urgency]} ${job.window}. Our limit on this one is ${job.nte} dollars.`,
  ];
}

export const BRIEF_QUESTION =
  "Could you take it, and what's the soonest you could get someone out there?";

/** Quote calls describe the job without the NTE; the limit only comes up if the price is over. */
export function quoteBriefLines(job: CallJob, shortSite: string): string[] {
  return [
    `We're looking for a quote on a job at our ${shortSite} location, ${job.siteAddress}. ${firstWords(job.title, 10)}.`,
    `${URGENCY_PHRASE[job.urgency]} ${job.window}.`,
  ];
}

export const ESTIMATE_QUESTION =
  "Roughly what would that run? A ballpark's fine, or just your call-out fee and hourly rate.";
export const ARRIVAL_QUESTION = "Okay. And what's the soonest you could get someone out there?";
export const QUOTE_CLOSE =
  'Perfect, thanks so much. Our manager will confirm shortly by phone or email. Have a good one!';

const shortAck = (say: string): string =>
  say.trim().split(/\s+/).length <= 8 ? say : 'Got it, thanks.';

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
  /** Quote calls: the structured result, saved with the outcome. */
  quote?: QuoteResult;
  set?: Partial<
    Pick<
      CallDoc,
      | 'noSpeechCount'
      | 'llmFailures'
      | 'vendorTurns'
      | 'briefRead'
      | 'pendingArrival'
      | 'pendingSpeech'
      | 'quoteStage'
      | 'stageTries'
      | 'estimate'
      | 'heardArrival'
      | 'arrivalConfirmed'
      | 'nteAsked'
      | 'nteAnswer'
      | 'quoteNotes'
    >
  >;
  model?: string | null;
  latencyMs?: number | null;
  action?: CallAction | QuoteTurnDecision['action'] | null;
}

type WebhookBody = Record<string, unknown>;

export interface CallServiceDeps {
  env: Env;
  /** Null when Twilio isn't configured. */
  provider: CallProvider | null;
  llm: LlmClient;
  models: TurnModels;
  now?: () => Date;
  /** Chain hook: a chain call reached its final status (wired by the dispatch chain service). */
  onChainCallEnded?: (call: CallDoc) => Promise<void>;
  /** True when a call chain is working on this work order (blocks the manual Call button). */
  chainActive?: (workOrderId: string) => Promise<boolean>;
}

/** Vendor dispatch phone call: Twilio <Say>/<Gather> turns, one Groq call per vendor reply. */
export class CallService {
  private readonly env: Env;
  private readonly now: () => Date;

  constructor(readonly deps: CallServiceDeps) {
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

  /** CALLS_ENABLED on, Twilio configured, and not in Advise mode (Advise disables all calls). */
  async assertCallsAllowed(): Promise<void> {
    if (!this.env.CALLS_ENABLED) throw new CallError('Vendor calls are disabled', 403);
    if (!this.isConfigured() || !this.deps.provider) {
      throw new CallError('Vendor calls are not configured on this server', 503);
    }
    const settings = await SettingsModel.findById('global').lean();
    if (settings?.autonomyMode === 'advise') {
      throw new CallError('Advise mode is on: vendor calls are disabled', 409);
    }
  }

  /** True while any call is still on the line. Every call rings the same phone, so one at a time. */
  async lineBusy(): Promise<boolean> {
    return Boolean(
      await CallModel.exists({
        endedAt: null,
        createdAt: { $gt: new Date(this.now().getTime() - STALE_CALL_MS) },
      }),
    );
  }

  /**
   * POST /api/work-orders/:id/call: a one-off booking call to the assigned vendor. Gated by
   * CALLS_ENABLED + the admin key and the call caps.
   */
  async start(workOrderId: string, adminKey: string | undefined): Promise<CallDoc> {
    if (!this.env.CALLS_ENABLED) throw new CallError('Vendor calls are disabled', 403);
    if (!this.checkAdminKey(adminKey)) throw new CallError('Admin key required', 401);
    await this.assertCallsAllowed();
    const wo = await WorkOrderModel.findById(workOrderId).lean();
    if (!wo) throw new CallError('Work order not found', 404);
    if (wo.status !== 'dispatched' || !wo.vendorId) {
      throw new CallError(
        `Only dispatched work orders can be called (this one is ${wo.status})`,
        409,
      );
    }
    if (this.deps.chainActive && (await this.deps.chainActive(workOrderId))) {
      throw new CallError('The agent is already working through vendors for this job', 409);
    }
    return this.place({
      workOrderId,
      vendorId: wo.vendorId,
      purpose: 'book',
      chainId: null,
      actor: 'manager',
    });
  }

  /**
   * Places one call. Shared by the manual Call button and the call-chain scheduler; the caller
   * has already checked the admin key (chains are started by an admin). Enforces one call at a
   * time, MAX_CALLS_PER_WORK_ORDER and MAX_CALLS_PER_HOUR. Placements Twilio refuses don't count.
   */
  async place(input: PlaceCallInput): Promise<CallDoc> {
    if (!this.isConfigured() || !this.deps.provider) {
      throw new CallError('Vendor calls are not configured on this server', 503);
    }
    const wo = await WorkOrderModel.findById(input.workOrderId).lean();
    if (!wo) throw new CallError('Work order not found', 404);
    if (
      input.purpose === 'book' &&
      (wo.status !== 'dispatched' || wo.vendorId !== input.vendorId)
    ) {
      throw new CallError(`${wo.number} is not dispatched to this vendor`, 409);
    }
    if (input.purpose === 'quote' && wo.status !== 'approved') {
      throw new CallError(
        `${wo.number} is ${wo.status}; quotes are only collected before dispatch`,
        409,
      );
    }
    if (input.callId) {
      const existing = await CallModel.findById(input.callId).lean();
      if (existing) return existing;
    }
    if (await this.lineBusy()) {
      throw new CallError('Another call is in progress; calls run one at a time', 409, 'busy');
    }
    const now = this.now();
    const counted = { endedReason: { $ne: 'failed' } };
    const perWo = { ...counted, workOrderId: wo._id };
    const perHour = { ...counted, createdAt: { $gt: new Date(now.getTime() - 3600_000) } };
    if ((await CallModel.countDocuments(perWo)) >= MAX_CALLS_PER_WORK_ORDER) {
      throw new CallError(
        `Call limit reached for ${wo.number} (${MAX_CALLS_PER_WORK_ORDER} calls)`,
        429,
        'work_order_cap',
      );
    }
    if ((await CallModel.countDocuments(perHour)) >= MAX_CALLS_PER_HOUR) {
      throw new CallError(
        `Call limit reached (${MAX_CALLS_PER_HOUR} per hour). Try later.`,
        429,
        'hourly_cap',
      );
    }
    const [vendor, site] = await Promise.all([
      VendorModel.findById(input.vendorId).lean(),
      SiteModel.findById(wo.siteId).lean(),
    ]);
    if (!vendor || !site) throw new CallError('Vendor or site not found', 409);

    const id = input.callId ?? newId('call');
    const quotedArrival = input.bookingQuote?.earliestArrival
      ? new Date(input.bookingQuote.earliestArrival)
      : null;
    try {
      await CallModel.create({
        _id: id,
        callSid: null,
        workOrderId: wo._id,
        workOrderNumber: wo.number,
        workOrderTitle: wo.title,
        vendorId: vendor._id,
        vendorName: vendor.name,
        siteName: site.name,
        purpose: input.purpose,
        chainId: input.chainId,
        bookingQuote: input.bookingQuote ?? null,
        // A quoted arrival is read back in the brief, so a plain "yes" can confirm it.
        pendingArrival: quotedArrival && quotedArrival > now ? quotedArrival : null,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return (await CallModel.findById(id).lean())!;
      throw err;
    }
    // Two concurrent starts can both pass the checks above; re-check with ours included.
    const raced =
      (await CallModel.countDocuments({
        _id: { $ne: id },
        endedAt: null,
        createdAt: { $gt: new Date(now.getTime() - STALE_CALL_MS) },
      })) > 0 ||
      (await CallModel.countDocuments(perHour)) > MAX_CALLS_PER_HOUR ||
      (await CallModel.countDocuments(perWo)) > MAX_CALLS_PER_WORK_ORDER;
    if (raced) {
      await CallModel.deleteOne({ _id: id });
      throw new CallError('Another call started at the same moment; try again', 409, 'busy');
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
      await this.callEnded(id);
      throw new CallError(
        err instanceof DialError ? msg : 'Twilio could not place the call; email fallback used',
        502,
      );
    }
    await logActivity({
      step: 'call',
      actor: input.actor,
      workOrderId: wo._id,
      inputSummary: `Call ${vendor.name} about ${wo.number}`,
      outputSummary:
        input.purpose === 'quote'
          ? 'Quote call started (demo number only)'
          : input.bookingQuote
            ? 'Booking call to the picked vendor started (demo number only)'
            : 'Dispatch call started (demo number only)',
    });
    return (await CallModel.findById(id).lean())!;
  }

  /**
   * Runs the chain hook once per call after it reaches a final status, so the next call in a
   * chain never starts while this one is still on the line.
   */
  async callEnded(callId: string): Promise<void> {
    const call = await CallModel.findOneAndUpdate(
      { _id: callId, endedAt: { $ne: null }, chainNotifiedAt: null },
      { chainNotifiedAt: this.now() },
      { new: true },
    ).lean();
    if (!call || !call.chainId || !this.deps.onChainCallEnded) return;
    try {
      await this.deps.onChainCallEnded(call);
    } catch (err) {
      await CallModel.updateOne({ _id: callId }, { chainNotifiedAt: null });
      throw err;
    }
  }

  /**
   * Ends calls that never got a final status callback (lost webhook, server restart), so the
   * line frees up and their chains move on.
   */
  async sweepStaleCalls(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - STALE_CALL_MS);
    const stale = await CallModel.find({ endedAt: null, createdAt: { $lte: cutoff } }).lean();
    for (const c of stale) {
      const now = this.now();
      await CallModel.updateOne(
        { _id: c._id, endedAt: null },
        { status: 'ended', endedReason: 'no final status', endedAt: now, updatedAt: now },
      );
      await CallModel.updateOne(
        { _id: c._id, outcome: null },
        { outcome: 'email_fallback', reason: 'No final status from Twilio', updatedAt: now },
      );
      await this.applyOutcome(c._id);
      await this.callEnded(c._id);
    }
    // Calls whose hook failed earlier get another try.
    const missed = await CallModel.find({
      endedAt: { $ne: null },
      chainId: { $ne: null },
      chainNotifiedAt: null,
    })
      .limit(20)
      .lean();
    for (const c of missed) await this.callEnded(c._id);
    return stale.length;
  }

  private render(callId: string, n: number, plan: TurnPlan): string {
    const r = new twilio.twiml.VoiceResponse();
    // Any Twilio voice name works; the SDK's union type lags behind the voices Twilio offers.
    const say = { voice: this.env.CALL_VOICE as 'alice', language: 'en-US' } as const;
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
        hints:
          'yes, no, today, tomorrow, morning, afternoon, a.m., p.m., stop, call back, dollars, hundred, call-out fee, hourly rate, an hour',
        // Twilio's phone-call model is better with numbers than the default one.
        speechModel: 'phone_call',
        enhanced: true,
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
    // People say "Lakeshore Plumbing", not "Lakeshore Plumbing Co.".
    const question = `Is this ${call.vendorName.replace(/,?\s+(Co|Inc|LLC)\.?$/i, '')}?`;
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
    const plan = await this.plan(call, speech, retry, now, confidence);
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
      if (plan.quote) set.quote = plan.quote;
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

  private async plan(
    call: CallDoc,
    speech: string,
    retry: boolean,
    now: Date,
    confidence: number | null,
  ): Promise<TurnPlan> {
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
        ["I'm out of time here, so our manager will follow up by email. Thanks, bye now."],
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
        ["Seems like I lost you, so we'll follow up by email. Bye now."],
        'email_fallback',
        'No speech from the vendor',
      );
    }

    const stop = matchStopPhrase(speech);
    if (stop) {
      return goodbye(
        ["No problem, sorry to bother you. We won't call again about this one. Bye now."],
        'opted_out',
        `Vendor said "${stop}"`,
      );
    }

    const job = await this.jobFor(call);
    const transcript = call.transcript.map((t) => ({ speaker: t.speaker, text: t.text }));
    const modelDown = (err: unknown): TurnPlan => {
      const msg = err instanceof Error ? err.message : String(err);
      if (call.llmFailures === 0 && !retry) {
        return {
          says: ['Sorry, just one sec.'],
          question: null,
          redirectRetry: true,
          set: { llmFailures: 1, pendingSpeech: speech },
        };
      }
      return goodbye(
        ["Sorry, I'm having some trouble on my end. We'll follow up by email. Bye now."],
        'email_fallback',
        `Model unavailable: ${msg}`.slice(0, 300),
      );
    };

    if (call.purpose === 'quote') {
      let qt: ModelTurn<QuoteTurnDecision>;
      try {
        qt = await decideQuoteTurn(this.deps.llm, this.deps.models, {
          job: job.job,
          transcript,
          vendorSaid: speech,
          stage: call.quoteStage,
          pendingArrival: call.pendingArrival,
          now,
        });
      } catch (err) {
        return modelDown(err);
      }
      return this.planQuote(call, speech, confidence, qt, job, now, goodbye);
    }

    let turn;
    try {
      turn = await decideTurn(this.deps.llm, this.deps.models, {
        job: job.job,
        transcript,
        vendorSaid: speech,
        briefRead: call.briefRead,
        pendingArrival: call.pendingArrival,
        now,
      });
    } catch (err) {
      return modelDown(err);
    }

    const d = turn.decision;
    const meta = {
      model: turn.model,
      latencyMs: turn.latencyMs,
      action: d.action,
    };
    const vendorTurns = call.vendorTurns + 1;
    const base = { vendorTurns, pendingSpeech: null };
    const spoken = validArrival(parseSpokenArrival(speech, now), now);
    const arrival =
      spoken ?? validArrival(d.arrivalTime ? localIsoToUtc(d.arrivalTime) : null, now);
    // A yes to the read-back confirms it even if the model echoed the time back differently.
    const pending = call.pendingArrival;
    const confirmsPending =
      call.briefRead &&
      pending !== null &&
      (d.action === 'confirm_job' || (d.action === 'continue' && isPlainYes(speech))) &&
      !(spoken && !sameMinute(spoken, pending));
    const readBack = (at: Date): TurnPlan => ({
      says: [],
      question: `Okay, so you'd be there ${formatSpokenTime(at, now)}, right?`,
      set: { ...base, pendingArrival: at },
      ...meta,
    });

    let plan: TurnPlan;
    switch (confirmsPending ? 'confirm_job' : d.action) {
      case 'confirm_job': {
        if (pending && (confirmsPending || !arrival || sameMinute(arrival, pending))) {
          plan = {
            ...goodbye(
              [
                `Perfect, you're all set for ${formatSpokenTime(pending, now)}.`,
                `Your reference is work order ${spokenWorkOrder(call.workOrderNumber)}. Thanks so much, bye now.`,
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
            question: "And what's the soonest you could get there?",
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
            ...this.bookBrief(call, job, d.say, now),
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
          ['Thanks for your time. Our manager will follow up by email. Bye now.'],
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

  /** Booking call brief. A quote winner hears their quote and arrival time back. */
  private bookBrief(
    call: CallDoc,
    job: { job: CallJob; shortSite: string },
    ack: string,
    now: Date,
  ): { says: string[]; question: string } {
    const says = [ack, ...briefLines(job.job, job.shortSite)];
    const q = call.bookingQuote;
    if (!q) return { says, question: BRIEF_QUESTION };
    const est = spokenEstimate(q);
    says.push(`We'd like to go ahead and book you.${est ? ` You'd quoted us ${est}.` : ''}`);
    const at = call.pendingArrival;
    return {
      says,
      question: at ? `Does ${formatSpokenTime(at, now)} still work for you?` : BRIEF_QUESTION,
    };
  }

  /**
   * Quote call: the code asks the questions in order (company, estimate, arrival with a
   * read-back, then the limit question once if the estimate is over the NTE) and the model
   * extracts answers. Never books; closes with "our manager will confirm shortly".
   */
  private planQuote(
    call: CallDoc,
    speech: string,
    confidence: number | null,
    turn: ModelTurn<QuoteTurnDecision>,
    job: { job: CallJob; shortSite: string },
    now: Date,
    goodbye: (says: string[], outcome: CallOutcome, reason: string | null) => TurnPlan,
  ): TurnPlan {
    const d = turn.decision;
    const meta = { model: turn.model, latencyMs: turn.latencyMs, action: d.action };
    const vendorTurns = call.vendorTurns + 1;
    const set: NonNullable<TurnPlan['set']> = { vendorTurns, pendingSpeech: null };
    const stated = d.estimate ? normalizeEstimate(d.estimate) : null;
    if (stated) set.estimate = stated;
    if (d.notes) set.quoteNotes = [...call.quoteNotes, d.notes];
    const spoken = validArrival(parseSpokenArrival(speech, now), now);
    const arrival =
      spoken ?? validArrival(d.arrivalTime ? localIsoToUtc(d.arrivalTime) : null, now);
    // A yes to the read-back saves the arrival, whatever else the model decided this turn
    // (it can answer "continue", "end", or echo the time back a day off).
    const confirmed =
      call.quoteStage === 'arrival' &&
      call.pendingArrival !== null &&
      (d.action === 'agree' || isPlainYes(speech)) &&
      !(spoken && !sameMinute(spoken, call.pendingArrival))
        ? call.pendingArrival
        : null;
    if (confirmed) set.arrivalConfirmed = confirmed;
    const nte = job.job.nte;
    const confidences = [
      ...call.transcript.filter((t) => t.speaker === 'vendor').map((t) => t.confidence),
      confidence,
    ].filter((c): c is number => c !== null);

    const result = (): QuoteResult =>
      finalizeQuote({
        estimate: set.estimate ?? call.estimate,
        earliestArrival:
          set.arrivalConfirmed !== undefined ? set.arrivalConfirmed : call.arrivalConfirmed,
        nte,
        nteAsked: set.nteAsked ?? call.nteAsked,
        nteAnswer: set.nteAnswer !== undefined ? set.nteAnswer : call.nteAnswer,
        notes: set.quoteNotes ?? call.quoteNotes,
        confidences,
      });
    const hasInfo = (): boolean =>
      Boolean(set.estimate ?? call.estimate ?? set.arrivalConfirmed ?? call.arrivalConfirmed);
    const finish = (says: string[] = [QUOTE_CLOSE]): TurnPlan => ({
      ...goodbye(says, 'quoted', null),
      quote: result(),
      set,
      ...meta,
    });
    const ask = (question: string, extra: NonNullable<TurnPlan['set']> = {}): TurnPlan => ({
      says: [],
      question,
      set: { ...set, ...extra },
      ...meta,
    });
    const readBack = (at: Date): TurnPlan =>
      ask(`Okay, so that's ${formatSpokenTime(at, now)}, right?`, {
        quoteStage: 'arrival',
        stageTries: 0,
        pendingArrival: at,
      });
    const askArrival = (): TurnPlan => {
      const heard = arrival ?? call.heardArrival;
      return heard
        ? readBack(heard)
        : ask(ARRIVAL_QUESTION, { quoteStage: 'arrival', stageTries: 0 });
    };
    const afterArrival = (confirmed: Date | null): TurnPlan => {
      set.arrivalConfirmed = confirmed;
      if (!call.nteAsked && overNte(set.estimate ?? call.estimate, nte)) {
        return ask(
          `Just so you know, our limit on this one is ${nte} dollars. Any chance you could work within that?`,
          {
            quoteStage: 'limit',
            stageTries: 0,
            nteAsked: true,
          },
        );
      }
      return finish();
    };

    switch (d.action) {
      case 'decline_job':
        return { ...goodbye([d.say], 'declined', d.reason ?? speech.slice(0, 200)), set, ...meta };
      case 'request_callback':
        return {
          ...goodbye([d.say], 'callback_requested', d.reason ?? speech.slice(0, 200)),
          callbackAt: arrival,
          set,
          ...meta,
        };
      case 'end':
        return hasInfo()
          ? finish([d.say])
          : { ...goodbye([d.say], 'ended', d.reason), set, ...meta };
    }

    let plan: TurnPlan;
    switch (call.quoteStage) {
      case 'identity':
        if (arrival) set.heardArrival = arrival;
        plan = {
          says: [shortAck(d.say), ...quoteBriefLines(job.job, job.shortSite)],
          question: ESTIMATE_QUESTION,
          set: { ...set, briefRead: true, quoteStage: 'estimate', stageTries: 0 },
          ...meta,
        };
        break;
      case 'estimate':
        if (arrival) set.heardArrival = arrival;
        if (stated) {
          plan = askArrival();
        } else if (call.stageTries >= 1) {
          // Two unclear answers: record "no estimate" and move on.
          set.estimate = call.estimate ?? normalizeEstimate({ quoteType: 'none' })!;
          plan = askArrival();
        } else {
          plan = ask(d.say, { stageTries: call.stageTries + 1 });
        }
        break;
      case 'arrival':
        if (confirmed) {
          plan = afterArrival(confirmed);
        } else if (arrival && !(call.pendingArrival && sameMinute(arrival, call.pendingArrival))) {
          plan = readBack(arrival);
        } else if (call.stageTries >= 1) {
          plan = afterArrival(null);
        } else {
          plan = ask(d.say, { stageTries: call.stageTries + 1 });
        }
        break;
      case 'limit': {
        const answer = d.withinNte ?? (d.action === 'agree' ? 'yes' : null);
        if (answer || call.stageTries >= 1) {
          set.nteAnswer = answer;
          plan = finish();
        } else {
          plan = ask(d.say, { stageTries: call.stageTries + 1 });
        }
        break;
      }
    }

    if (!plan.hangup && vendorTurns >= MAX_QUOTE_TURNS) {
      plan = hasInfo()
        ? finish()
        : {
            ...goodbye(
              ['Thanks for your time. Our manager will follow up by email. Bye now.'],
              'ended',
              'Turn limit reached without a quote',
            ),
            set,
            ...meta,
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
    await this.callEnded(callId);
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
          {
            status: 'accepted',
            eta: call.eta,
            ...(call.bookingQuote ? { agreedQuote: call.bookingQuote } : {}),
            updatedAt: now,
          },
        );
        output =
          res.modifiedCount === 1
            ? `Status dispatched → accepted${call.bookingQuote ? `; agreed estimate ${formatEstimate(call.bookingQuote)} (approximate) stored` : ''}. ${summary}`
            : `Work order was no longer dispatched to this vendor; nothing changed. ${summary}`;
      } else if (call.outcome === 'declined' && !call.chainId) {
        reassignProposalId = await proposeNextVendor(call, now);
      } else if (call.chainId && call.outcome !== 'quoted') {
        output = `${summary} The call chain takes the next step once the call ends.`;
      } else if (call.outcome === 'quoted') {
        output = summary;
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
  call: Pick<CallDoc, 'outcome' | 'eta' | 'callbackAt' | 'reason' | 'transcript'> & {
    quote?: QuoteResult | null;
  },
): string {
  const head: Record<CallOutcome, string> = {
    confirmed: `Vendor confirmed; arriving ${call.eta ? etaText(call.eta) : 'at an unknown time'}.`,
    quoted: quoteHeadline(call.quote ?? null),
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

const LIMIT_ANSWER: Record<QuoteResult['withinNte'], string> = {
  yes: 'within the limit',
  no: 'can’t work within the limit',
  maybe: 'maybe within the limit',
  unknown: 'limit not discussed',
};

function quoteHeadline(q: QuoteResult | null): string {
  if (!q) return 'Quote call ended.';
  const ceiling = estimateCeiling(q);
  return [
    `Quote ${formatEstimate(q)}${ceiling !== null ? ' (approximate)' : ''}`,
    LIMIT_ANSWER[q.withinNte],
    q.earliestArrival
      ? `earliest arrival ${etaText(new Date(q.earliestArrival))}`
      : 'no arrival time',
  ]
    .join('; ')
    .concat(q.notes ? `. Notes: ${q.notes}.` : '.');
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
