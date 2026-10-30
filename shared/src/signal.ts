import { z } from 'zod';
import { SensorMetric, SensorUnit } from './enums';

const IsoDateTime = z.iso.datetime({ offset: true });

/** A free-text request, e.g. from the QR request portal. */
export const RequestSignalInput = z.object({
  type: z.literal('request'),
  siteId: z.string().min(1),
  text: z.string().trim().min(3).max(2000),
  submittedAt: IsoDateTime.optional(),
});
export type RequestSignalInput = z.infer<typeof RequestSignalInput>;

/** A single sensor reading pushed by a device (or the demo simulator). */
export const SensorSignalInput = z.object({
  type: z.literal('sensor'),
  assetId: z.string().min(1),
  metric: SensorMetric,
  value: z.number().finite(),
  unit: SensorUnit,
  readingAt: IsoDateTime.optional(),
});
export type SensorSignalInput = z.infer<typeof SensorSignalInput>;

/** Body of POST /api/signals. */
export const SignalInput = z.discriminatedUnion('type', [RequestSignalInput, SensorSignalInput]);
export type SignalInput = z.infer<typeof SignalInput>;
