import { SITE_TIME_ZONE } from '../pipeline/plan';

/** Wall-clock time in a zone. `month` is 1-12. */
export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function localParts(date: Date, tz = SITE_TIME_ZONE): LocalDateTime & { weekday: number } {
  const p = Object.fromEntries(
    formatter(tz)
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAY_INDEX[p.weekday ?? 'Sun'] ?? 0,
  };
}

/** Minutes the zone is ahead of UTC at `date` (negative for America/New_York). */
function offsetMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

/** Wall-clock time in `tz` -> instant. Two passes so it lands right across DST changes. */
export function zonedToUtc(local: LocalDateTime, tz = SITE_TIME_ZONE): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  t = guess - offsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

/** "2026-11-02T09:00" (local, no offset) -> instant, or null if malformed. */
export function localIsoToUtc(iso: string, tz = SITE_TIME_ZONE): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return zonedToUtc({ year, month, day, hour, minute }, tz);
}

/** Calendar date `days` after the local date of `now`. */
function addLocalDays(now: Date, days: number, tz: string): Omit<LocalDateTime, 'hour' | 'minute'> {
  const p = localParts(now, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  'forty five': 45,
  'forty-five': 45,
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Speech-to-text output -> one canonical form: lowercase, digits, "am"/"pm". */
function normalize(text: string): string {
  let s = ` ${text.toLowerCase()} `
    .replace(/a\.\s?m\.?/g, 'am')
    .replace(/p\.\s?m\.?/g, 'pm')
    .replace(/o'?\s?clock/g, "o'clock")
    .replace(/[,?!;]/g, ' ')
    .replace(/\.(?!\d)/g, ' ');
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    s = s.replace(new RegExp(`\\b${word}\\b`, 'g'), String(n));
  }
  return s
    .replace(/\b(\d{1,2}) (15|30|45)\b/g, '$1:$2') // "nine thirty" -> 9:30
    .replace(/\s+/g, ' ');
}

type DayPart = 'morning' | 'afternoon' | 'evening' | null;

/** Hour without am/pm: business-hours guess unless the phrase says when in the day. */
function to24h(hour: number, meridiem: string | undefined, part: DayPart): number | null {
  if (hour < 0 || hour > 23) return null;
  if (hour > 12) return meridiem === 'am' ? null : hour;
  if (meridiem === 'am') return hour === 12 ? 0 : hour;
  if (meridiem === 'pm') return hour === 12 ? 12 : hour + 12;
  if (part === 'morning') return hour === 12 ? 0 : hour;
  if (part === 'afternoon' || part === 'evening') return hour === 12 ? 12 : hour + 12;
  // Vendors work days: 7-11 means morning, 12 is noon, 1-6 means afternoon.
  if (hour === 12) return 12;
  return hour >= 7 ? hour : hour + 12;
}

export interface SpokenArrival {
  at: Date;
  /**
   * True when the time was relative or vague ("tomorrow", "in 2 days", "next Tuesday", "Monday
   * morning", a bare clock time): the agent reads it back and asks "Is that right?". False for a
   * named day or date plus a clock time ("Tuesday at 11"), which gets a short "got it" read-back.
   */
  relative: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Monday-first position in the week, so a Sunday's "next Tuesday" is two days away. */
const weekPos = (weekday: number): number => (weekday + 6) % 7;

/** Default hour for a day part with no clock time ("Monday morning"). */
const DAY_PART_HOUR: Record<Exclude<DayPart, null>, number> = {
  morning: 9,
  afternoon: 13,
  evening: 17,
};

/**
 * Resolves a vendor's spoken arrival time ("tomorrow at 9", "in two hours", "10 a.m. in 2 days",
 * "next Tuesday at 11", "Monday, November 2 at 10 AM") against `now` (the call's date) in the
 * site's zone. Returns null when there is no clear time; the agent then asks again.
 */
export function parseArrival(text: string, now: Date, tz = SITE_TIME_ZONE): SpokenArrival | null {
  const raw = normalize(text);
  const ordinal = /\b(?:the )?(\d{1,2})(?:st|nd|rd|th)\b/.exec(raw);
  const s = raw.replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, '$1');

  // Relative: "in 2 hours", "in an hour and a half", "in half an hour", "in 45 minutes".
  if (/\bin half an hour\b/.test(s)) {
    return { at: new Date(now.getTime() + 30 * 60_000), relative: true };
  }
  const rel =
    /\bin (?:about |around )?(an|a|\d+(?:\.\d+)?)( and a half)? (hour|hr|minute|min)s?( and a half)?\b/.exec(
      s,
    );
  if (rel) {
    const n = rel[1] === 'a' || rel[1] === 'an' ? 1 : Number(rel[1]);
    const half = rel[2] || rel[4] ? 0.5 : 0;
    const minutes = (rel[3]!.startsWith('h') ? 60 : 1) * (n + half);
    // "in a minute" is a figure of speech, not an arrival time.
    if (minutes >= 10 && minutes <= 72 * 60) {
      return { at: new Date(now.getTime() + minutes * 60_000), relative: true };
    }
  }

  // Day.
  let dayOffset: number | null = null;
  let relative = false;
  let part: DayPart = null;
  const today = localParts(now, tz);
  const daysAhead =
    /\bin (?:a couple(?: of)?|(\d+)) days?\b/.exec(s) ??
    /\b(\d+) days? from (?:now|today)\b/.exec(s) ??
    /\bfrom (\d+) days?\b/.exec(s);
  const month = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})\b/.exec(s);
  if (/\bday after tomorrow\b/.test(s)) [dayOffset, relative] = [2, true];
  else if (daysAhead) [dayOffset, relative] = [daysAhead[1] ? Number(daysAhead[1]) : 2, true];
  else if (/\btomorrow\b/.test(s)) [dayOffset, relative] = [1, true];
  else if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) {
    [dayOffset, relative] = [0, true];
  } else if (month) {
    const m = MONTHS.indexOf(month[1]!);
    const d = Number(month[2]);
    const base = Date.UTC(today.year, today.month - 1, today.day);
    let target = Date.UTC(today.year, m, d);
    if (target < base) target = Date.UTC(today.year + 1, m, d);
    dayOffset = Math.round((target - base) / 86_400_000);
  } else {
    const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(s));
    if (wd >= 0) {
      dayOffset = (wd - today.weekday + 7) % 7;
      if (new RegExp(`\\bnext ${WEEKDAYS[wd]}\\b`).test(s)) {
        // "Next Tuesday" is next week's Tuesday; on a weekend that's the coming one.
        if (dayOffset === 0 || weekPos(wd) > weekPos(today.weekday)) dayOffset += 7;
        relative = true;
      } else if (new RegExp(`\\bthis ${WEEKDAYS[wd]}\\b`).test(s)) {
        relative = true;
      }
    } else if (ordinal) {
      // "the 3rd at 11": the next time that day of the month comes around.
      const d = Number(ordinal[1]);
      const base = Date.UTC(today.year, today.month - 1, today.day);
      let target = Date.UTC(today.year, today.month - 1, d);
      if (target < base) target = Date.UTC(today.year, today.month, d);
      if (d >= 1 && d <= 31) dayOffset = Math.round((target - base) / 86_400_000);
    }
  }
  if (/\bmorning\b/.test(s)) part = 'morning';
  else if (/\bafternoon\b/.test(s)) part = 'afternoon';
  else if (/\b(evening|tonight)\b/.test(s)) part = 'evening';

  // Time: "noon", "9 am", "9:30", "at 9", "around 9 o'clock". A bare number needs "at" or
  // similar so "2 trucks" is never read as a time.
  let hour: number | null = null;
  let minute = 0;
  if (/\bnoon\b/.test(s)) hour = 12;
  else {
    const t =
      /\b(\d{1,2})(?::(\d{2}))? ?(am|pm)\b/.exec(s) ??
      /\b(?:at|around|by|about|before) (\d{1,2})(?::(\d{2}))?(?: (am|pm|o'clock))?\b/.exec(s) ??
      /\b(\d{1,2}):(\d{2})\b/.exec(s) ??
      /\b(\d{1,2})(?::(\d{2}))? o'clock\b/.exec(s);
    if (t) {
      const meridiem = t[3] === 'am' || t[3] === 'pm' ? t[3] : undefined;
      hour = to24h(Number(t[1]), meridiem, part);
      minute = t[2] ? Number(t[2]) : 0;
      if (minute > 59) hour = null;
    }
  }
  if (hour === null && part && dayOffset !== null) {
    // "Monday morning": a vague time, read back for a yes.
    hour = DAY_PART_HOUR[part];
    relative = true;
  }
  if (hour === null) return null;

  const resolve = (offset: number): Date => {
    const d = addLocalDays(now, offset, tz);
    return zonedToUtc({ ...d, hour: hour!, minute }, tz);
  };
  if (dayOffset === null) {
    // No day: the next time that clock time comes around.
    const sameDay = resolve(0);
    return { at: sameDay > now ? sameDay : resolve(1), relative: true };
  }
  let at = resolve(dayOffset);
  // "Monday at 9" said on a Monday afternoon means next Monday.
  if (at <= now && dayOffset === 0 && !/\b(today|tonight|this )/.test(s)) at = resolve(7);
  return at > now ? { at, relative } : null;
}

/** The arrival instant only; see parseArrival. */
export function parseSpokenArrival(text: string, now: Date, tz = SITE_TIME_ZONE): Date | null {
  return parseArrival(text, now, tz)?.at ?? null;
}

/** "11 AM", "3:30 PM", "noon". */
function spokenClock(date: Date, tz: string): string {
  const p = localParts(date, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return p.hour === 12 && p.minute === 0
    ? 'noon'
    : `${h12}${p.minute ? `:${String(p.minute).padStart(2, '0')}` : ''} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

const ordinalSuffix = (n: number): string => {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

const weekdayName = (date: Date, tz: string): string =>
  date.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });

/**
 * Read-back with the date, so there's no doubt which day: "Tuesday the 3rd at 11 AM". With `now`,
 * a time later today reads "today at 2 PM".
 */
export function spokenDayDate(date: Date, tz = SITE_TIME_ZONE, now?: Date): string {
  if (now) {
    const p = localParts(date, tz);
    const t = localParts(now, tz);
    if (p.year === t.year && p.month === t.month && p.day === t.day) {
      return `today at ${spokenClock(date, tz)}`;
    }
  }
  return `${weekdayName(date, tz)} the ${ordinalSuffix(localParts(date, tz).day)} at ${spokenClock(date, tz)}`;
}

/** Short form for a time both sides already know: "Tuesday at 11 AM", "today at 2 PM". */
export function spokenWeekdayTime(date: Date, now: Date, tz = SITE_TIME_ZONE): string {
  const p = localParts(date, tz);
  const t = addLocalDays(now, 0, tz);
  if (p.year === t.year && p.month === t.month && p.day === t.day) {
    return `today at ${spokenClock(date, tz)}`;
  }
  return date.getTime() - now.getTime() < 6 * 86_400_000
    ? `${weekdayName(date, tz)} at ${spokenClock(date, tz)}`
    : spokenDayDate(date, tz);
}

/** How the agent reads a time back: "today at 3:30 PM", "tomorrow at 9 AM", "Monday, Nov 2 at 9 AM". */
export function formatSpokenTime(date: Date, now: Date, tz = SITE_TIME_ZONE): string {
  const clock = spokenClock(date, tz);
  const p = localParts(date, tz);
  const sameDate = (offset: number): boolean => {
    const d = addLocalDays(now, offset, tz);
    return d.year === p.year && d.month === p.month && d.day === p.day;
  };
  if (sameDate(0)) return `today at ${clock}`;
  if (sameDate(1)) return `tomorrow at ${clock}`;
  const day = date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  });
  return `${day} at ${clock}`;
}

/** Seven-day calendar for the model, so "Tuesday" maps to a date by lookup, not arithmetic. */
export function calendarLines(now: Date, tz = SITE_TIME_ZONE): string[] {
  return Array.from({ length: 8 }, (_, i) => {
    const d = addLocalDays(now, i, tz);
    const noon = zonedToUtc({ ...d, hour: 12, minute: 0 }, tz);
    const name = noon.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
    const iso = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    const label = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
    return `${name} ${iso}${label}`;
  });
}
