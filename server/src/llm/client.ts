import OpenAI from 'openai';
import { z } from 'zod';
import type { TokenUsage } from '@fia/shared';

export interface LlmRequest<T> {
  model: string;
  system: string;
  user: string;
  /** Name for the JSON schema sent to the provider. */
  schemaName: string;
  schema: z.ZodType<T>;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface LlmResult<T> {
  data: T;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
}

/** The only way the app talks to a model. Tests swap in a fake. */
export interface LlmClient {
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
]);

/**
 * zod -> JSON schema for strict structured outputs: every property required, objects closed,
 * nullables as type unions. Range and format keywords are stripped (zod re-validates them).
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (!UNSUPPORTED_KEYWORDS.has(k)) out[k] = strip(v);
      }
      return out;
    }
    return node;
  };
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface GroqClientOptions {
  apiKey: string;
  baseURL: string;
  maxRetries?: number;
}

/** OpenAI-compatible client (Groq by default). Structured outputs, no streaming, no tools. */
export class OpenAiCompatibleClient implements LlmClient {
  private readonly client: OpenAI;
  private readonly maxRetries: number;

  constructor(opts: GroqClientOptions) {
    // The SDK's own retries are disabled so 429 handling (Retry-After + backoff) lives here.
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      maxRetries: 0,
      timeout: 60_000,
    });
    this.maxRetries = opts.maxRetries ?? 5;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        // Groq-specific fields (reasoning_effort, include_reasoning) are passed through as-is.
        const body = {
          model: req.model,
          messages: [
            { role: 'system' as const, content: req.system },
            { role: 'user' as const, content: req.user },
          ],
          temperature: 0,
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: req.schemaName,
              strict: true,
              schema: toStrictJsonSchema(req.schema),
            },
          },
          ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
          include_reasoning: false,
        };
        const completion = await this.client.chat.completions.create(
          body as OpenAI.ChatCompletionCreateParamsNonStreaming,
        );
        const content = completion.choices[0]?.message?.content ?? '';
        const parsed = req.schema.safeParse(JSON.parse(content));
        if (!parsed.success) {
          throw new LlmError(`Model output failed validation: ${parsed.error.message}`, false);
        }
        return {
          data: parsed.data,
          model: completion.model ?? req.model,
          usage: {
            promptTokens: completion.usage?.prompt_tokens ?? 0,
            completionTokens: completion.usage?.completion_tokens ?? 0,
            totalTokens: completion.usage?.total_tokens ?? 0,
          },
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        const retryable =
          err instanceof OpenAI.APIError
            ? err.status === 429 || (err.status ?? 0) >= 500
            : err instanceof OpenAI.APIConnectionError;
        if (!retryable || attempt >= this.maxRetries) {
          if (err instanceof LlmError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          throw new LlmError(`LLM call failed: ${msg}`, retryable);
        }
        await sleep(retryDelayMs(err, attempt));
      }
    }
  }
}

/** Honors Retry-After on 429; otherwise exponential backoff with jitter (1s, 2s, 4s, ...). */
export function retryDelayMs(err: unknown, attempt: number): number {
  if (err instanceof OpenAI.APIError) {
    const header = err.headers?.get?.('retry-after');
    const seconds = header ? Number(header) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 60) * 1000 + 250;
  }
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 300);
}
