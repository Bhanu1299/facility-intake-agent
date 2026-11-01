import twilio from 'twilio';
import type { Env } from '../env';
import { dialTarget } from './dial';

/** Everything an outbound call needs except the number: callers can't choose who is dialed. */
export interface OutboundCall {
  /** TwiML URL fetched when the call is answered. */
  answerUrl: string;
  statusCallbackUrl: string;
  /** Hard cap on call length, seconds. */
  timeLimit: number;
  /** Seconds to ring before no-answer. */
  ringTimeout: number;
}

/** Thin seam over Twilio's REST API so tests never place real calls. */
export interface CallProvider {
  create(params: OutboundCall & { to: string; from: string }): Promise<{ sid: string }>;
  /** Ends a live call (our own time limit, for when Twilio didn't take timeLimit). */
  hangup(sid: string): Promise<void>;
}

/** Places the demo call. `to` always comes from dialTarget(); see dial.ts. */
export function placeDemoCall(
  provider: CallProvider,
  env: Pick<Env, 'DEMO_VENDOR_PHONE' | 'TWILIO_FROM_NUMBER'>,
  call: OutboundCall,
): Promise<{ sid: string }> {
  return provider.create({ ...call, to: dialTarget(env), from: env.TWILIO_FROM_NUMBER });
}

/**
 * Twilio Programmable Voice, Calls.create:
 * https://www.twilio.com/docs/voice/api/call-resource#create-a-call-resource
 */
export class TwilioCallProvider implements CallProvider {
  private readonly client: twilio.Twilio;

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }

  async create(p: OutboundCall & { to: string; from: string }): Promise<{ sid: string }> {
    const basic = {
      to: p.to,
      from: p.from,
      url: p.answerUrl,
      method: 'POST',
      statusCallback: p.statusCallbackUrl,
      statusCallbackMethod: 'POST',
    } as const;
    try {
      const call = await this.client.calls.create({
        ...basic,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeLimit: p.timeLimit,
        timeout: p.ringTimeout,
      });
      return { sid: call.sid };
    } catch (err) {
      // Some trial accounts reject optional parameters. Retry with the basics; CallService
      // enforces the time limit itself, and only the final status callback arrives.
      if (!isTrialParameterError(err)) throw withCode(err);
      console.warn('[calls] Twilio refused optional call parameters; retrying with the basics');
      try {
        return { sid: (await this.client.calls.create(basic)).sid };
      } catch (err2) {
        throw withCode(err2);
      }
    }
  }

  async hangup(sid: string): Promise<void> {
    await this.client.calls(sid).update({ status: 'completed' });
  }
}

export function isTrialParameterError(err: unknown): boolean {
  return err instanceof Error && /trial accounts have limited parameter access/i.test(err.message);
}

/** Puts Twilio's error code in the message so the stored call reason says which error it was. */
function withCode(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (err instanceof Error && code !== undefined && !err.message.includes(String(code))) {
    err.message = `${err.message} (Twilio error ${String(code)})`;
  }
  return err;
}
