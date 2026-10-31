import type { Env } from '../env';

export class DialError extends Error {}

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * The one place that decides which number is dialed: always DEMO_VENDOR_PHONE, the author's own
 * number verified on the Twilio trial. Vendor phone numbers in the database are fake and are
 * never passed here, so no code path can call them.
 */
export function dialTarget(env: Pick<Env, 'DEMO_VENDOR_PHONE'>): string {
  const to = env.DEMO_VENDOR_PHONE.trim();
  if (!E164.test(to)) throw new DialError('DEMO_VENDOR_PHONE must be an E.164 number (+1...)');
  return to;
}

/** "+17165550100" -> "7 1 6, 5 5 5, 0 1 0 0" (Twilio reads spaced digits one by one). */
export function spokenDigits(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const groups =
    national.length === 10
      ? [national.slice(0, 3), national.slice(3, 6), national.slice(6)]
      : [national];
  return groups.map((g) => g.split('').join(' ')).join(', ');
}
