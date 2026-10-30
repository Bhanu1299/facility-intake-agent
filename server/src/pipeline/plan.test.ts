import { NTE_TABLE } from '../config/nte';
import type { VendorDoc } from '../models/catalog';
import { generateSeedData } from '../seed/generate';
import { haversineMiles, nextAvailableAt, planNte, rankVendors, SCORE_WEIGHTS } from './plan';

// Thursday 2026-10-29 10:00 in Buffalo (EDT, UTC-4).
const THU_10AM = new Date('2026-10-29T14:00:00Z');

describe('planNte', () => {
  it('uses the trade x urgency table from the spec', () => {
    expect(NTE_TABLE.plumbing).toEqual({ low: 150, routine: 250, urgent: 400, emergency: 750 });
    expect(NTE_TABLE.hvac.emergency).toBe(1200);
    expect(NTE_TABLE.refrigeration.urgent).toBe(700);
    expect(NTE_TABLE.electrical.routine).toBe(300);
    expect(NTE_TABLE.handyman.low).toBe(100);
    expect(NTE_TABLE.pest_control.emergency).toBe(500);
  });

  it('returns the table NTE when the budget covers it', () => {
    expect(planNte('hvac', 'urgent', 5000)).toEqual({
      tableNte: 600,
      available: 5000,
      nte: 600,
      needsBudgetIncrease: false,
      shortfall: 0,
    });
  });

  it('caps NTE at Available and flags the shortfall', () => {
    expect(planNte('refrigeration', 'emergency', 350)).toEqual({
      tableNte: 1500,
      available: 350,
      nte: 350,
      needsBudgetIncrease: true,
      shortfall: 1150,
    });
  });

  it('exactly enough budget is not a shortfall', () => {
    expect(planNte('plumbing', 'urgent', 400).needsBudgetIncrease).toBe(false);
  });

  it('negative Available caps at 0', () => {
    const p = planNte('plumbing', 'low', -20);
    expect(p.nte).toBe(0);
    expect(p.shortfall).toBe(150);
  });
});

describe('haversineMiles', () => {
  it('is ~0 for the same point and ~6 mi Elmwood to Cheektowaga', () => {
    const elm = { lat: 42.9265, lng: -78.8774 };
    expect(haversineMiles(elm, elm)).toBe(0);
    expect(haversineMiles(elm, { lat: 42.9068, lng: -78.7593 })).toBeCloseTo(6.1, 0);
  });
});

const vendor = (overrides: Partial<VendorDoc>): VendorDoc => ({
  _id: 'v',
  name: 'V',
  trades: ['plumbing'],
  lat: 42.9,
  lng: -78.85,
  rating: 4,
  performanceScore: 80,
  hourlyRate: 100,
  email: 'v@example',
  phone: '',
  insuranceExpiry: new Date('2027-06-15T12:00:00Z'),
  emergency24x7: false,
  windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' }],
  bookedUntil: null,
  ...overrides,
});

describe('nextAvailableAt', () => {
  it('is now when inside a window', () => {
    expect(nextAvailableAt(vendor({}), THU_10AM)?.toISOString()).toBe(THU_10AM.toISOString());
  });

  it('waits for the next window in local time (Fri 8:00 EDT)', () => {
    const thu6pm = new Date('2026-10-29T22:00:00Z');
    expect(nextAvailableAt(vendor({}), thu6pm)?.toISOString()).toBe('2026-10-30T12:00:00.000Z');
  });

  it('respects bookings and the horizon', () => {
    const booked = vendor({ bookedUntil: new Date('2026-11-02T13:00:00Z') }); // Mon 8am EST
    expect(nextAvailableAt(booked, THU_10AM, 24)).toBeNull();
    expect(nextAvailableAt(booked, THU_10AM)?.toISOString()).toBe('2026-11-02T13:00:00.000Z');
  });
});

describe('rankVendors', () => {
  const site = { lat: 42.9265, lng: -78.8774 };

  it('excludes expired insurance and unavailable vendors with a reason', () => {
    const r = rankVendors(
      [
        vendor({ _id: 'ok', name: 'OK' }),
        vendor({ _id: 'exp', name: 'Expired', insuranceExpiry: new Date('2026-10-01') }),
        vendor({ _id: 'busy', name: 'Busy', bookedUntil: new Date('2026-11-05T00:00:00Z') }),
        vendor({ _id: 'hvac', name: 'HVAC', trades: ['hvac'] }),
      ],
      site,
      'plumbing',
      'urgent',
      THU_10AM,
    );
    expect(r.top.map((v) => v.vendorId)).toEqual(['ok']);
    expect(r.excluded).toEqual([
      { vendorId: 'exp', name: 'Expired', reason: 'Insurance expired 2026-10-01' },
      { vendorId: 'busy', name: 'Busy', reason: 'Not available within 24h (urgent)' },
    ]);
  });

  it('emergency needs a start within 4h: business-hours vendor fails at night', () => {
    const night = new Date('2026-10-30T03:00:00Z'); // Thu 11pm local
    const r = rankVendors(
      [
        vendor({ _id: 'day' }),
        vendor({
          _id: 'allday',
          windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }],
        }),
      ],
      site,
      'plumbing',
      'emergency',
      night,
    );
    expect(r.top.map((v) => v.vendorId)).toEqual(['allday']);
    expect(r.excluded[0]?.reason).toBe('Not available within 4h (emergency)');
  });

  it('scores performance 40 / distance 30 / rating 20 / price 10 and returns the top 3', () => {
    expect(SCORE_WEIGHTS).toEqual({ performance: 0.4, distance: 0.3, rating: 0.2, price: 0.1 });
    const vendors = [
      // Best on everything except price.
      vendor({
        _id: 'a',
        performanceScore: 95,
        rating: 4.9,
        lat: 42.926,
        lng: -78.877,
        hourlyRate: 140,
      }),
      // Cheapest, far, weak.
      vendor({
        _id: 'b',
        performanceScore: 70,
        rating: 4.0,
        lat: 43.05,
        lng: -78.7,
        hourlyRate: 60,
      }),
      vendor({
        _id: 'c',
        performanceScore: 85,
        rating: 4.5,
        lat: 42.95,
        lng: -78.85,
        hourlyRate: 100,
      }),
      vendor({
        _id: 'd',
        performanceScore: 75,
        rating: 4.1,
        lat: 43.0,
        lng: -78.75,
        hourlyRate: 90,
      }),
    ];
    const r = rankVendors(vendors, site, 'plumbing', 'routine', THU_10AM);
    expect(r.top).toHaveLength(3);
    expect(r.top[0]!.vendorId).toBe('a');
    // a: perf 1*0.4 + dist 1*0.3 + rating 1*0.2 + price 0*0.1 = 0.9
    expect(r.top[0]!.score).toBeCloseTo(0.9, 3);
    expect(r.top[0]!.reason).toMatch(
      /^Closest \(\d+(\.\d)? mi\), 4\.9 rating, top performance score \(95\), insurance valid to Jun 2027\.$/,
    );
    expect(r.top.map((v) => v.vendorId)).not.toContain('b');
  });

  it('returns nothing (and lists exclusions) when no vendor passes', () => {
    const r = rankVendors(
      [vendor({ insuranceExpiry: new Date('2020-01-01') })],
      site,
      'plumbing',
      'routine',
      THU_10AM,
    );
    expect(r.top).toEqual([]);
    expect(r.excluded).toHaveLength(1);
  });

  it('on seed data, expired-insurance vendors never appear in the top 3', () => {
    const now = new Date();
    const seed = generateSeedData(now);
    for (const trade of ['hvac', 'refrigeration'] as const) {
      const r = rankVendors(seed.vendors, seed.sites[0]!, trade, 'routine', now);
      const expired = seed.vendors.filter((v) => v.insuranceExpiry < now).map((v) => v._id);
      expect(r.top.some((v) => expired.includes(v.vendorId))).toBe(false);
    }
  });
});
