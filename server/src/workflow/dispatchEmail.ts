import type { DispatchEmail, Urgency } from '@fia/shared';

const URGENCY_LINE: Record<Urgency, string> = {
  emergency: 'EMERGENCY: please respond within 4 hours.',
  urgent: 'Urgent: please respond within 24 hours.',
  routine: 'Routine: please schedule within 5 days.',
  low: 'Low priority: please schedule within 14 days.',
};

export interface DispatchEmailInput {
  vendor: { name: string; email: string };
  site: { name: string; address: string; hours: string };
  workOrder: {
    number: string;
    title: string;
    description: string;
    locationText: string;
    urgency: Urgency;
    nte: number;
  };
  assetName: string | null;
  /** Set when a new report was merged into an existing work order. */
  update?: { note: string; urgencyRaised: boolean } | null;
}

/** Draft dispatch email. Generated for review and stored; never actually sent. */
export function buildDispatchEmail(input: DispatchEmailInput): DispatchEmail {
  const { vendor, site, workOrder: wo, assetName, update } = input;
  const subject = update
    ? `Update to ${wo.number}: ${wo.title} (${site.name})`
    : `New work order ${wo.number}: ${wo.title} (${site.name})`;
  const lines = [
    `Hello ${vendor.name},`,
    '',
    update
      ? `There is a new report on work order ${wo.number}, which is already assigned to you.`
      : `${site.name} would like to dispatch you on the work order below.`,
    '',
    `Work order: ${wo.number}`,
    `Problem: ${wo.title}`,
    ...(assetName ? [`Equipment: ${assetName}`] : []),
    `Location: ${wo.locationText || 'see description'}`,
    `Site: ${site.address} (hours: ${site.hours})`,
    `Priority: ${URGENCY_LINE[wo.urgency]}`,
    `Not-to-exceed: $${wo.nte.toLocaleString('en-US')}. Please call before any work above this amount.`,
    '',
    update ? `New report: ${update.note}` : `Details: ${wo.description}`,
    ...(update?.urgencyRaised ? ['', 'Priority has been raised because of this report.'] : []),
    '',
    'Please reply to confirm you can take this job and your expected arrival time.',
    '',
    'Thank you,',
    `Facilities, ${site.name}`,
  ];
  return { to: vendor.email, subject, body: lines.join('\n'), sent: false };
}
