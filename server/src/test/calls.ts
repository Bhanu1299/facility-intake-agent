import twilio from 'twilio';
import request from 'supertest';
import type { CallTurnDecision, QuoteTurnDecision } from '@fia/shared';
import type { CallProvider } from '../calls/provider';
import { loadEnv } from '../env';
import type { LlmClient, LlmRequest, LlmResult } from '../llm/client';

/** Shared fakes for vendor call tests: never talks to Twilio or Groq. */
export const PUBLIC = 'https://api.example.test';
export const TOKEN = 'test-auth-token';
export const ADMIN = 'admin-key-123';
export const DEMO_PHONE = '+17165550199';

export const callEnv = (overrides: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    DEMO_RATE_LIMIT_PER_HOUR: '1000',
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_FROM_NUMBER: '+17165550100',
    DEMO_VENDOR_PHONE: DEMO_PHONE,
    CALL_ADMIN_KEY: ADMIN,
    CALLS_ENABLED: 'true',
    PUBLIC_API_URL: PUBLIC,
    ...overrides,
  });

/** Records every Calls.create; never talks to Twilio. */
export class FakeProvider implements CallProvider {
  readonly created: Parameters<CallProvider['create']>[0][] = [];
  private n = 0;
  async create(p: Parameters<CallProvider['create']>[0]): Promise<{ sid: string }> {
    this.created.push(p);
    return { sid: `CA${String(++this.n).padStart(32, '0')}` };
  }
  readonly hungUp: string[] = [];
  async hangup(sid: string): Promise<void> {
    this.hungUp.push(sid);
  }
}

/** A partial turn decision (book or quote call), or an error to throw. */
export type Scripted = Partial<CallTurnDecision> | Partial<QuoteTurnDecision> | Error;

/** Scripted call-turn model: hands out decisions in order and records what it was asked. */
export class ScriptedLlm implements LlmClient {
  readonly calls: LlmRequest<unknown>[] = [];
  constructor(private readonly script: Scripted[]) {}
  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push(req as LlmRequest<unknown>);
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedLlm ran out of turns');
    if (next instanceof Error) throw next;
    const defaults =
      req.schemaName === 'quote_turn' ? { estimate: null, withinNte: null, notes: null } : {};
    const data = req.schema.parse({
      say: 'Okay.',
      action: 'continue',
      arrivalTime: null,
      reason: null,
      ...defaults,
      ...next,
    });
    return {
      data,
      model: req.model,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 3,
    };
  }
}

/** Posts a form body signed the way Twilio signs it: HMAC over the public URL plus params. */
export function signedPost(
  app: Parameters<typeof request>[0],
  path: string,
  params: Record<string, string>,
) {
  const sig = twilio.getExpectedTwilioSignature(TOKEN, `${PUBLIC}${path}`, params);
  return request(app).post(path).type('form').set('X-Twilio-Signature', sig).send(params);
}
