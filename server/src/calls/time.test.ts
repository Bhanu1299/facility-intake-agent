import {
  formatSpokenTime,
  localIsoToUtc,
  parseArrival,
  parseSpokenArrival,
  spokenDayDate,
  spokenWeekdayTime,
} from './time';

// Wednesday Nov 4 2026, 10:00 AM in Buffalo (EST, UTC-5).
const now = new Date('2026-11-04T15:00:00Z');
const at = (text: string): string | undefined => parseSpokenArrival(text, now)?.toISOString();

describe('parseSpokenArrival (America/New_York)', () => {
  it.each([
    ['tomorrow at 9', '2026-11-05T14:00:00.000Z'],
    ['Tomorrow at 9 a.m.', '2026-11-05T14:00:00.000Z'],
    ['I can be there tomorrow around 2:30 p.m.', '2026-11-05T19:30:00.000Z'],
    ['in two hours', '2026-11-04T17:00:00.000Z'],
    ['in an hour and a half', '2026-11-04T16:30:00.000Z'],
    ['in 45 minutes', '2026-11-04T15:45:00.000Z'],
    ['today at 3', '2026-11-04T20:00:00.000Z'],
    ['this afternoon at 1:15', '2026-11-04T18:15:00.000Z'],
    ['around noon', '2026-11-04T17:00:00.000Z'],
    ['Friday at 8 am', '2026-11-06T13:00:00.000Z'],
    ['nine thirty tomorrow morning', '2026-11-05T14:30:00.000Z'],
    ['tomorrow at nine thirty', '2026-11-05T14:30:00.000Z'],
  ])('%s', (text, expected) => {
    expect(at(text)).toBe(expected);
  });

  it('a bare clock time that already passed today means tomorrow', () => {
    expect(at('at 9 am')).toBe('2026-11-05T14:00:00.000Z');
  });

  it('same weekday later than now is next week', () => {
    expect(at('Wednesday at 9 am')).toBe('2026-11-11T14:00:00.000Z');
  });

  it('returns null when there is no time', () => {
    expect(at('yes I can take it')).toBeUndefined();
    expect(at('I have 2 trucks free')).toBeUndefined();
    expect(at('give me a minute')).toBeUndefined();
    expect(at('tomorrow')).toBeUndefined();
  });

  it('crosses the DST change correctly', () => {
    // Saturday Oct 31 2026, 2 PM EDT; DST ends Sunday Nov 1 at 2 AM.
    const sat = new Date('2026-10-31T18:00:00Z');
    expect(parseSpokenArrival('tomorrow at 9', sat)?.toISOString()).toBe(
      '2026-11-01T14:00:00.000Z',
    );
    expect(localIsoToUtc('2026-10-31T09:00')?.toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(localIsoToUtc('2026-11-02T09:00')?.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });
});

describe('relative and vague dates (America/New_York, from the call date)', () => {
  // Now: Wednesday Nov 4 2026, 10:00 AM.
  it.each([
    ['10 a.m. from 2 days', '2026-11-06T15:00:00.000Z'],
    ['in 2 days at 10 am', '2026-11-06T15:00:00.000Z'],
    ['in two days, around 10', '2026-11-06T15:00:00.000Z'],
    ['2 days from now at 10', '2026-11-06T15:00:00.000Z'],
    ['day after tomorrow at 9', '2026-11-06T14:00:00.000Z'],
    ['this Tuesday at 11', '2026-11-10T16:00:00.000Z'],
    ['next Tuesday at 11', '2026-11-10T16:00:00.000Z'],
    ['Monday morning', '2026-11-09T14:00:00.000Z'],
    ['tomorrow afternoon', '2026-11-05T18:00:00.000Z'],
  ])('%s is relative and needs a yes', (text, expected) => {
    const a = parseArrival(text, now);
    expect(a?.at.toISOString()).toBe(expected);
    expect(a?.relative).toBe(true);
  });

  it('"this Tuesday" vs "next Tuesday" said on a Monday', () => {
    const monday = new Date('2026-11-02T15:00:00Z');
    expect(parseSpokenArrival('this Tuesday at 11', monday)?.toISOString()).toBe(
      '2026-11-03T16:00:00.000Z',
    );
    expect(parseSpokenArrival('next Tuesday at 11', monday)?.toISOString()).toBe(
      '2026-11-10T16:00:00.000Z',
    );
  });

  it('a named day or date with a clock time is clear', () => {
    expect(parseArrival('Tuesday at eleven', now)).toEqual({
      at: new Date('2026-11-10T16:00:00.000Z'),
      relative: false,
    });
    // The Lakeshore quote call: said on Saturday Oct 31 (EDT), arrival after the DST change.
    const sat = new Date('2026-10-31T22:00:00Z');
    expect(parseArrival('Monday, November 2 at 10 AM', sat)).toEqual({
      at: new Date('2026-11-02T15:00:00.000Z'),
      relative: false,
    });
    expect(parseArrival('Tuesday the 3rd at 11', sat)).toEqual({
      at: new Date('2026-11-03T16:00:00.000Z'),
      relative: false,
    });
  });

  it('read-back forms', () => {
    const sat = new Date('2026-10-31T22:00:00Z');
    const tue = new Date('2026-11-03T16:00:00.000Z');
    expect(spokenDayDate(tue)).toBe('Tuesday the 3rd at 11 AM');
    expect(spokenWeekdayTime(tue, sat)).toBe('Tuesday at 11 AM');
    expect(spokenWeekdayTime(new Date('2026-11-12T16:00:00.000Z'), sat)).toBe(
      'Thursday the 12th at 11 AM',
    );
  });
});

describe('formatSpokenTime', () => {
  it('reads back relative to today', () => {
    expect(formatSpokenTime(new Date('2026-11-04T20:30:00Z'), now)).toBe('today at 3:30 PM');
    expect(formatSpokenTime(new Date('2026-11-05T14:00:00Z'), now)).toBe('tomorrow at 9 AM');
    expect(formatSpokenTime(new Date('2026-11-06T17:00:00Z'), now)).toBe(
      'Friday, November 6 at noon',
    );
  });
});
