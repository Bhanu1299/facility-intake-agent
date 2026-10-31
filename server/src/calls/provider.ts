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
    const call = await this.client.calls.create({
      to: p.to,
      from: p.from,
      url: p.answerUrl,
      method: 'POST',
      statusCallback: p.statusCallbackUrl,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeLimit: p.timeLimit,
      timeout: p.ringTimeout,
    });
    return { sid: call.sid };
  }
}
