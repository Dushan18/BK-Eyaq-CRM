import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  ReservationRequestStatus,
  ReservationStatus,
} from '../../generated/prisma/enums';

export function requestCompleteness(
  at: Date | null,
  people: number | null,
): ReservationRequestStatus {
  return at !== null && people !== null
    ? ReservationRequestStatus.READY_TO_SEND
    : ReservationRequestStatus.INCOMPLETE_DATA;
}

export function futureReservationDate(value: string, now = new Date()): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date <= now) {
    throw new BadRequestException(
      'La fecha de reserva debe ser válida y futura',
    );
  }
  return date;
}

export function reservationDateRange(from?: string, to?: string) {
  const gte = from === undefined ? undefined : new Date(from);
  const lt = to === undefined ? undefined : new Date(to);
  if (
    (gte && !Number.isFinite(gte.getTime())) ||
    (lt && !Number.isFinite(lt.getTime())) ||
    (gte && lt && gte >= lt)
  ) {
    throw new BadRequestException(
      'dateFrom debe ser anterior a dateTo y las fechas deben ser válidas',
    );
  }
  return gte || lt ? { gte, lt } : undefined;
}

export function requireRequestEditable(status: ReservationRequestStatus) {
  if (
    status !== ReservationRequestStatus.INCOMPLETE_DATA &&
    status !== ReservationRequestStatus.READY_TO_SEND
  ) {
    throw new ConflictException(
      'La solicitud no admite modificaciones en su estado actual',
    );
  }
}

export function requireReservationTransition(
  current: ReservationStatus,
  next: ReservationStatus,
  at: Date,
  now = new Date(),
) {
  const allowed: Partial<
    Record<ReservationStatus, readonly ReservationStatus[]>
  > = {
    CONFIRMED: ['IN_SERVICE', 'CANCELLED', 'NO_SHOW'],
    IN_SERVICE: ['COMPLETED'],
  };
  const active: ReservationStatus[] = [
    'CONFIRMED',
    'IN_SERVICE',
    'COMPLETED',
    'CANCELLED',
    'NO_SHOW',
  ];
  if (!active.includes(next))
    throw new BadRequestException('Estado no habilitado en esta fase');
  if (current === next) return;
  if (!allowed[current]?.includes(next))
    throw new ConflictException('Transición de reserva no permitida');
  if ((next === 'IN_SERVICE' || next === 'NO_SHOW') && at > now) {
    throw new ConflictException('Todavía no ha llegado la hora de la reserva');
  }
}

export function requireNonemptyPatch(dto: object) {
  if (!Object.values(dto).some((value) => value !== undefined))
    throw new BadRequestException(
      'Proporciona al menos un campo para actualizar',
    );
}

export function bookingPagination(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
