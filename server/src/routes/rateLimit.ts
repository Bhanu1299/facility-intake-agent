import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';

/**
 * Per-IP hourly limit for endpoints that cost money (LLM calls) or reset shared demo state.
 * One limiter instance = one shared budget across the routes it is mounted on.
 */
export function demoRateLimit(perHour: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: perHour,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: `Demo limit reached: ${perHour} requests per hour. Try again later.` },
  });
}
