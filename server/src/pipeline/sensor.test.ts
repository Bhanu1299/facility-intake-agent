import type { SensorSpec } from '@fia/shared';
import { assessSensor, slopePerDay, type Point } from './sensor';
import { SENSOR_SPECS } from '../seed/data';

const NOW = new Date('2026-10-30T12:00:00Z').getTime();
const HOUR = 3_600_000;

/** Hourly points over the last `hours`, value = start + perDay * days elapsed. */
function series(hours: number, start: number, perDay: number): Point[] {
  return Array.from({ length: hours + 1 }, (_, i) => ({
    at: new Date(NOW - (hours - i) * HOUR),
    value: start + (perDay * i) / 24,
  }));
}

/** The new reading, taken at NOW. */
const at = (value: number): Point => ({ at: new Date(NOW), value });

const cooler = SENSOR_SPECS.walkin_cooler as SensorSpec;
const freezer = SENSOR_SPECS.walkin_freezer as SensorSpec;
const rtu = SENSOR_SPECS.rooftop_ac as SensorSpec;
const heater = SENSOR_SPECS.water_heater as SensorSpec;

describe('slopePerDay', () => {
  it('recovers a known linear trend', () => {
    expect(slopePerDay(series(48, 36, 0.5))).toBeCloseTo(0.5, 6);
    expect(slopePerDay(series(48, 130, -2))).toBeCloseTo(-2, 6);
  });

  it('returns null with too little data', () => {
    expect(slopePerDay([])).toBeNull();
    expect(slopePerDay([{ at: new Date(NOW), value: 1 }])).toBeNull();
    expect(
      slopePerDay([
        { at: new Date(NOW), value: 1 },
        { at: new Date(NOW), value: 2 },
      ]),
    ).toBeNull();
  });

  it('is ~0 for a flat noisy series', () => {
    const pts = series(48, 36.5, 0).map((p, i) => ({
      ...p,
      value: p.value + (i % 2 ? 0.2 : -0.2),
    }));
    expect(Math.abs(slopePerDay(pts)!)).toBeLessThan(0.05);
  });
});

describe('assessSensor', () => {
  it('cooler 1.5F past 41 is urgent', () => {
    const a = assessSensor(cooler, at(42.5), series(48, 36.5, 0));
    expect(a.urgency).toBe('urgent');
    expect(a.pastThreshold).toBe(true);
    expect(a.severity).toBeCloseTo(0.5);
  });

  it('freezer 7F past 5 is an emergency', () => {
    expect(assessSensor(freezer, at(12), series(48, -5, 0)).urgency).toBe('emergency');
  });

  it('AC vibration 2.4 past 7.0 is an emergency', () => {
    expect(assessSensor(rtu, at(9.4), series(48, 3, 0)).urgency).toBe('emergency');
  });

  it('water heater 6F below the 110 alert is urgent (alert-below threshold)', () => {
    const a = assessSensor(heater, at(104), series(48, 130, 0));
    expect(a.urgency).toBe('urgent');
    expect(a.severity).toBeCloseTo(0.6);
  });

  it('cooler within limits but rising ~0.5F/day toward 41 is urgent with a trend note', () => {
    const history = series(48, 39.4, 0.5);
    const a = assessSensor(cooler, at(40.4), history);
    expect(a.pastThreshold).toBe(false);
    expect(a.daysToThreshold).toBeCloseTo(1.2, 1);
    expect(a.urgency).toBe('urgent');
    expect(a.trendNote).toBe('At this rate it crosses the threshold in about 1 day.');
    expect(a.urgencyReason).not.toMatch(/predict/i);
  });

  it('slow rise crossing in 3-7 days is routine; flat is low', () => {
    expect(assessSensor(cooler, at(39), series(48, 38.5, 0.4)).urgency).toBe('routine'); // ~5 days
    const flat = assessSensor(cooler, at(36.5), series(48, 36.5, 0));
    expect(flat.urgency).toBe('low');
    expect(flat.trendNote).toBeNull();
  });

  it('a falling cooler (moving away from threshold) is low', () => {
    expect(assessSensor(cooler, at(37), series(48, 38, -0.5)).urgency).toBe('low');
  });

  it('water heater dropping toward 110 uses the downward trend', () => {
    const a = assessSensor(heater, at(114), series(48, 120, -3));
    expect(a.urgency).toBe('urgent');
    expect(a.daysToThreshold).toBeCloseTo(1.33, 1);
    expect(a.trendNote).toMatch(/in about 1 day/);
  });

  it('says "under a day" when very close', () => {
    expect(assessSensor(cooler, at(40.9), series(48, 39.9, 0.5)).trendNote).toMatch(/under a day/);
  });

  it('a sharp jump past the limit says "jumped from X to Y" with units, not a per-day rate', () => {
    const a = assessSensor(cooler, at(45), series(48, 36.5, 0));
    expect(a.urgency).toBe('emergency');
    expect(a.jumpedFrom).toBeCloseTo(36.5);
    expect(a.urgencyReason).toBe(
      'Reading 45 °F is 4.0 °F above the 41 °F limit; it jumped from 36.5 to 45 °F since the previous reading.',
    );
    expect(a.urgencyReason).not.toMatch(/per day/);
  });

  it('a jump that stays under the limit is still reported as a jump', () => {
    const a = assessSensor(cooler, at(40.5), series(48, 36.5, 0));
    expect(a.pastThreshold).toBe(false);
    expect(a.urgencyReason).toBe(
      'Reading 40.5 °F is within limits (0.5 °F below the 41 °F limit), but it jumped from 36.5 to 40.5 °F since the previous reading.',
    );
  });

  it('a slow drift past the limit reports a 24h rate with units', () => {
    // Flat for a day, then +1.5 °F/day for the last 24h ending at 41.5.
    const history = [...series(48, 40, 0).slice(0, 24), ...series(24, 40, 1.5)];
    const a = assessSensor(cooler, at(41.5), history);
    expect(a.jumpedFrom).toBeNull();
    expect(a.slopePerDay).toBeCloseTo(1.5, 1);
    expect(a.urgencyReason).toBe(
      'Reading 41.5 °F is 0.5 °F above the 41 °F limit, still rising about 1.5 °F per day over the last 24h.',
    );
  });

  it('includes the new reading in the rate even when history does not contain it', () => {
    const withNew = assessSensor(cooler, at(40.4), series(48, 39.4, 0.5));
    const withoutNew = assessSensor(cooler, at(40.4), series(48, 39.4, 0.5).slice(0, -1));
    expect(withoutNew.slopePerDay).toBeCloseTo(withNew.slopePerDay!, 6);
  });

  it('alert-below sensors say "dropped from"', () => {
    const a = assessSensor(heater, at(100), series(48, 125, 0));
    expect(a.urgencyReason).toMatch(
      /10\.0 °F below the 110 °F limit; it dropped from 125 to 100 °F/,
    );
  });
});
