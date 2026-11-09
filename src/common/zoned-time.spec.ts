import { zonedTimeToUtc } from './zoned-time';

describe('Hora local del restaurante a UTC', () => {
  it('Lima (UTC-5): las 19:30 del 29/10 son las 00:30 UTC del 30/10', () => {
    expect(
      zonedTimeToUtc(
        { year: 2026, month: 10, day: 29, hour: 19, minute: 30 },
        'America/Lima',
      )?.toISOString(),
    ).toBe('2026-10-30T00:30:00.000Z');
  });
  it('respeta el horario de verano de la zona', () => {
    const local = { year: 2026, day: 1, hour: 12, minute: 0 };
    expect(
      zonedTimeToUtc({ ...local, month: 7 }, 'America/New_York')?.toISOString(),
    ).toBe('2026-07-01T16:00:00.000Z');
    expect(
      zonedTimeToUtc(
        { ...local, month: 12 },
        'America/New_York',
      )?.toISOString(),
    ).toBe('2026-12-01T17:00:00.000Z');
  });
  it.each([
    { year: 2026, month: 2, day: 31, hour: 12, minute: 0 },
    { year: 2026, month: 13, day: 1, hour: 12, minute: 0 },
    { year: 2026, month: 10, day: 29, hour: 24, minute: 0 },
    { year: 2026, month: 10, day: 29, hour: 19, minute: 60 },
  ])('una fecha u hora inexistente da null (%o)', (local) => {
    expect(zonedTimeToUtc(local, 'America/Lima')).toBeNull();
  });
});
