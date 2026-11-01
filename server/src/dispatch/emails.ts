import type { DispatchEmail, Urgency } from '@fia/shared';

interface EmailInput {
  vendor: { name: string; email: string };
  site: { name: string; address: string };
  workOrder: { number: string; title: string; description: string; urgency: Urgency };
}

const WINDOW: Record<Urgency, string> = {
  emergency: 'within 4 hours',
  urgent: 'within 24 hours',
  routine: 'within 5 days',
  low: 'within 14 days',
};

/** Request for quote after a missed quote call. Draft only; never sent. */
export function buildRfqEmail({ vendor, site, workOrder: wo }: EmailInput): DispatchEmail {
  return {
    to: vendor.email,
    subject: `Request for quote: ${wo.title} (${site.name})`,
    body: [
      `Hello ${vendor.name},`,
      '',
      `We tried to reach you by phone about a job at ${site.name} (${site.address}).`,
      '',
      `Work order: ${wo.number}`,
      `Problem: ${wo.title}`,
      `Needed: ${WINDOW[wo.urgency]}`,
      `Details: ${wo.description}`,
      '',
      'Could you reply with a rough estimate (or your call-out fee and hourly rate) and the',
      'earliest time you could arrive? We will call again shortly.',
      '',
      'Thank you,',
      `Facilities, ${site.name}`,
    ].join('\n'),
    sent: false,
  };
}

/** Polite "we've gone with another provider" note to a vendor who quoted. Draft only. */
export function buildDeclineEmail({ vendor, site, workOrder: wo }: EmailInput): DispatchEmail {
  return {
    to: vendor.email,
    subject: `Re: quote for ${wo.title} (${site.name})`,
    body: [
      `Hello ${vendor.name},`,
      '',
      `Thank you for taking our call and quoting on work order ${wo.number} (${wo.title}).`,
      "We've gone with another provider this time. We appreciate your time and hope to work",
      'with you on a future job.',
      '',
      'Thank you,',
      `Facilities, ${site.name}`,
    ].join('\n'),
    sent: false,
  };
}
