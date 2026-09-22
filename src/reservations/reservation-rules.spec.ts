import { ConflictException } from '@nestjs/common';
import {
  futureReservationDate,
  requestCompleteness,
  requireReservationTransition,
  reservationDateRange,
} from './reservation-rules';

describe('Reservation rules', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  it('calcula completitud', () => {
    expect(requestCompleteness(null, null)).toBe('INCOMPLETE_DATA');
    expect(requestCompleteness(now, null)).toBe('INCOMPLETE_DATA');
    expect(requestCompleteness(null, 4)).toBe('INCOMPLETE_DATA');
    expect(requestCompleteness(now, 4)).toBe('READY_TO_SEND');
  });
  it('fechas nuevas deben ser futuras', () => {
    expect(() => futureReservationDate(now.toISOString(), now)).toThrow();
    expect(() => futureReservationDate('invalid', now)).toThrow();
    expect(
      futureReservationDate('2026-09-20T08:00:00-05:00', now).toISOString(),
    ).toBe('2026-09-20T13:00:00.000Z');
  });
  it('rango semiabierto válido e inválido', () => {
    expect(reservationDateRange()).toBeUndefined();
    expect(
      reservationDateRange('2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'),
    ).toEqual({
      gte: new Date('2026-09-20T00:00:00Z'),
      lt: new Date('2026-09-21T00:00:00Z'),
    });
    expect(() =>
      reservationDateRange(now.toISOString(), now.toISOString()),
    ).toThrow();
  });
  it('controla transiciones y hora de servicio', () => {
    expect(() =>
      requireReservationTransition('CONFIRMED', 'IN_SERVICE', now, now),
    ).not.toThrow();
    expect(() =>
      requireReservationTransition('IN_SERVICE', 'COMPLETED', now, now),
    ).not.toThrow();
    expect(() =>
      requireReservationTransition('COMPLETED', 'CONFIRMED', now, now),
    ).toThrow(ConflictException);
    expect(() =>
      requireReservationTransition(
        'CONFIRMED',
        'NO_SHOW',
        new Date(now.getTime() + 1),
        now,
      ),
    ).toThrow(ConflictException);
    expect(() =>
      requireReservationTransition('CANCELLED', 'CANCELLED', now, now),
    ).not.toThrow();
  });
});
