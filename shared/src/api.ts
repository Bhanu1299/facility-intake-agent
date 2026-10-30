import { z } from 'zod';
import { AutonomyMode } from './enums';

export const HealthResponse = z.object({
  status: z.literal('ok'),
  db: z.enum(['connected', 'disconnected', 'connecting', 'disconnecting']),
  autonomyMode: AutonomyMode,
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const AutonomySetting = z.object({ mode: AutonomyMode });
export type AutonomySetting = z.infer<typeof AutonomySetting>;

export const ApiError = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
