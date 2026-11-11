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

// A person (OWNER or ADMIN) decides on a request. SENT_TO_OWNER and WAITING_RESPONSE
// are reached with the owner's WhatsApp approval (M9); they are accepted here already
// so that a person can still decide on a request waiting for the owner.
const AWAITING_DECISION: ReservationRequestStatus[] = [
  ReservationRequestStatus.READY_TO_SEND,
  ReservationRequestStatus.SENT_TO_OWNER,
  ReservationRequestStatus.WAITING_RESPONSE,
];
export function requireRequestApprovable(status: ReservationRequestStatus) {
  if (status === ReservationRequestStatus.INCOMPLETE_DATA)
    throw new ConflictException(
      'Completa la fecha y el número de personas antes de aprobar la solicitud',
    );
  if (!AWAITING_DECISION.includes(status))
    throw new ConflictException(
      'La solicitud no se puede aprobar en su estado actual',
    );
}
export function requireRequestRejectable(status: ReservationRequestStatus) {
  if (status === ReservationRequestStatus.ACCEPTED)
    throw new ConflictException(
      'La solicitud ya fue aprobada: cancela su reserva desde el calendario',
    );
  if (
    status !== ReservationRequestStatus.INCOMPLETE_DATA &&
    !AWAITING_DECISION.includes(status)
  )
    throw new ConflictException(
      'La solicitud no se puede rechazar en su estado actual',
    );
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
    CONFIRMED: ['UPCOMING', 'IN_SERVICE', 'CANCELLED', 'NO_SHOW'],
    UPCOMING: ['IN_SERVICE', 'CANCELLED', 'NO_SHOW'],
    RESCHEDULED: [
      'CONFIRMED',
      'UPCOMING',
      'IN_SERVICE',
      'CANCELLED',
      'NO_SHOW',
    ],
    IN_SERVICE: ['COMPLETED'],
  };
  const active: ReservationStatus[] = [
    'CONFIRMED',
    'UPCOMING',
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

export function requireReservationEditable(status: ReservationStatus) {
  if (
    status !== 'CONFIRMED' &&
    status !== 'UPCOMING' &&
    status !== 'RESCHEDULED'
  ) {
    throw new ConflictException(
      'La reserva no admite edición o reprogramación en su estado actual',
    );
  }
}

export function requireReservationAssignable(status: ReservationStatus) {
  if (
    status === 'COMPLETED' ||
    status === 'CANCELLED' ||
    status === 'NO_SHOW'
  ) {
    throw new ConflictException(
      'No se modifica el responsable de una reserva finalizada',
    );
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
