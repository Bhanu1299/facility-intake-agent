import type { Urgency } from '@fia/shared';
import { COMPANY_NAME } from '../seed/data';
import { localParts } from './time';

/**
 * Every fixed line the agent speaks. Style: one question per turn, short sentences (about 15
 * words at most), contractions, no lists, never a work order or reference number.
 */

/** Company name as spoken ("Harbor and Hearth Kitchen"). */
export const SPOKEN_COMPANY = COMPANY_NAME.replace(/&/g, 'and');

/** Most words a spoken sentence may have. */
export const MAX_SENTENCE_WORDS = 15;

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** Vendor name as people say it: "Queen City Drain & Pipe" -> "Queen City Drain". Speech only. */
export function spokenVendorName(name: string): string {
  const short = name
    .replace(/\s*&.*$/, '')
    .replace(/,?\s+(Co|Company|Inc|LLC|Corp|Ltd)\.?$/i, '')
    .trim();
  return short || name;
}

export const opener = (vendorName: string): { says: string[]; question: string } => ({
  says: [`Hi, this is an automated assistant calling for ${SPOKEN_COMPANY}.`],
  question: `Is this ${spokenVendorName(vendorName)}?`,
});

/** Timing after the job sentence, by urgency. */
export const TIMING: Record<Urgency, string> = {
  emergency: 'Emergency, as soon as possible.',
  urgent: 'Urgent, today if possible.',
  routine: 'Not urgent, sometime this week.',
  low: 'Not urgent, sometime in the next couple of weeks.',
};

const PREDICATE_START =
  "(?:is|are|keeps|keep|has|have|won't|wont|isn't|aren't|doesn't|don't|was|were|started|seems|stopped|will not|can't|cannot|needs)";
const NOT_A_THING = /^(there|it|this|that|we|i|you|they|he|she|someone|somebody|staff|everyone)$/i;

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Problem + severity in one sentence, in the requester's own words where the request reads as
 * "<thing> <is clogged and backing up>": "The mop sink at our Elmwood location is clogged and
 * backing up." Falls back to the work order title.
 */
export function jobSentence(requestText: string, title: string, shortSite: string): string {
  const where = `at our ${shortSite} location`;
  const first = (requestText.split(/(?<=[.!?])\s+|\n/)[0] ?? '').trim().replace(/[.!?]+$/, '');
  const m = new RegExp(
    `^(?:(?:hi|hey|hello)\\b[^a-z]*)?(?:the|our|a|an|my)?\\s*([a-z][\\w'’-]*(?:\\s+[\\w'’-]+){0,5}?)\\s+(${PREDICATE_START}\\b.*)$`,
    'i',
  ).exec(first);
  if (m && !NOT_A_THING.test(m[1]!.split(/\s+/)[0]!)) {
    const subject = m[1]!.toLowerCase();
    const predicate = m[2]!
      .split(/,|;| - | so | since | because | and it | and we /i)[0]!
      .trim()
      .split(/\s+/);
    const room = MAX_SENTENCE_WORDS - wordCount(`The ${subject} ${where}`);
    if (room >= 2) return `The ${subject} ${where} ${predicate.slice(0, room).join(' ')}.`;
  }
  const t = title.trim().replace(/[.!?]+$/, '');
  const words = t.split(/\s+/).slice(0, MAX_SENTENCE_WORDS - wordCount(where));
  return `${capitalize(words.join(' '))} ${where}.`;
}

const PARTICIPLES = new Set([
  'clogged',
  'leaking',
  'broken',
  'running',
  'dripping',
  'stuck',
  'cracked',
  'torn',
  'jammed',
  'overflowing',
  'frozen',
  'flickering',
  'tripped',
  'loose',
  'backed',
  'sticking',
  'rattling',
  'noisy',
  'damaged',
  'burst',
  'blocked',
  'failed',
  'slow',
  'warm',
  'dead',
]);
const BREAK_WORDS = new Set(['not', 'no', "won't", 'wont', 'making', 'above', 'at', 'in', 'on']);

/** The problem in a few words, for "about the clogged mop sink": from the work order title. */
export function problemShort(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words[0] === 'no' && words.length > 1) {
    const rest = words.slice(1);
    const stop = rest.findIndex((w) => BREAK_WORDS.has(w));
    return `${rest.slice(0, stop > 0 ? stop : 3).join(' ')} problem`;
  }
  const p = words.findIndex((w) => PARTICIPLES.has(w));
  if (p > 0 && p <= 4) return `${words[p]} ${words.slice(0, p).join(' ')}`;
  const b = words.findIndex((w) => BREAK_WORDS.has(w));
  if (b > 0 && b <= 4) return words.slice(0, b).join(' ');
  return words.slice(0, 4).join(' ');
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** "Saturday", or "earlier today" when the quote call was the same day. */
export function whenWeCalled(quoteCallAt: Date | null, now: Date): string {
  if (!quoteCallAt) return 'recently';
  const a = localParts(quoteCallAt);
  const b = localParts(now);
  if (a.year === b.year && a.month === b.month && a.day === b.day) return 'earlier today';
  return WEEKDAY_NAMES[a.weekday]!;
}

/** Booking a quote winner: who we are and what we called about. The vendor acknowledges. */
export const bookingOpener = (
  calledWhen: string,
  problem: string,
  shortSite: string,
): { says: string[]; question: string } => ({
  says: [`Hi, this is the automated assistant from ${SPOKEN_COMPANY}.`],
  question: `We called you ${calledWhen} about the ${problem} at our ${shortSite} location.`,
});

export const BOOK_NEWS = "Great news, we'd like to book you.";
export const stillWorks = (when: string): string => `${BOOK_NEWS} Does ${when} still work?`;
export const BOOK_ASK_NO_TIME = `${BOOK_NEWS} When's the earliest you could get there?`;
/** Book mode (no quote call first). */
export const BOOK_QUESTION = "Can you take it, and when's the earliest you could get there?";
export const bookedClose = (when: string, street: string): string[] => [
  `Perfect, ${when}.`,
  ...(street ? [`The address is ${street}.`] : []),
  'Thanks!',
];

export const ESTIMATE_QUESTION = 'Roughly what would that cost?';
/** Said once if the vendor hesitates on the price. Not phrased as a question, but it asks. */
export const ESTIMATE_NUDGE = 'Ballpark, or your hourly rate is fine.';
export const ARRIVAL_QUESTION = "When's the earliest you could get there?";
export const budgetQuestion = (nte: number): string =>
  `Our budget's about $${nte}. Could you work with that?`;
export const gotIt = (when: string): string => `${when}, got it.`;
export const isThatRight = (when: string): string => `${when}. Is that right?`;
export const QUOTE_CLOSE = [
  'Thanks.',
  'Our manager will get back to you soon.',
  'If you need us, this number calls us back.',
  'Have a good one.',
];
export const NO_DETAIL = "I don't have that detail. Our manager can fill you in.";

/** Lines the agent listens after that don't end in a question mark. */
export const LISTEN_LINES = new Set([ESTIMATE_NUDGE]);

/** "I don't remember", "what job?", "who is this?": restate the job before asking again. */
export function doesNotRecall(speech: string): boolean {
  return /\b(don'?t|do not|can'?t) (recall|remember)|\bwhat (job|was that|is this about)\b|\bwho( is|'s) (this|calling)\b|\bwhich (job|one)\b|\bnot sure what\b|\brefresh\b/i.test(
    speech,
  );
}
