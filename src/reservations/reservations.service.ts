import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { ReservationStatus, RoleCode } from '../../generated/prisma/enums';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import {
  CreateReservationDto,
  ReservationQueryDto,
  UpdateReservationDto,
  UpdateReservationStatusDto,
  AssignReservationDto,
  CreateReservationNoteDto,
  RescheduleReservationDto,
} from '../dto/reservation.dto';
import { ReservationSupportService } from './reservation-support.service';
import {
  bookingPagination,
  futureReservationDate,
  requireNonemptyPatch,
  requireReservationTransition,
  reservationDateRange,
  requireReservationEditable,
  requireReservationAssignable,
} from './reservation-rules';
import {
  reservationSelect,
  reservationDetailSelect,
  reservationNoteSelect,
  reservationResponse,
} from './reservation.select';

type ReservationRow = Prisma.ReservationGetPayload<{
  select: typeof reservationSelect;
}>;

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly support: ReservationSupportService,
  ) {}

  create(dto: CreateReservationDto) {
    return this.support.transaction(async (tx) => {
      const config = await this.support.configuration(tx);
      await this.support.customer(tx, dto.customerId);
      await this.support.commercialItem(tx, dto.commercialItemId);
      const at = futureReservationDate(dto.reservationAt);
      const now = new Date();
      const code = await this.support.code(
        tx,
        'reservation',
        config.timeZone,
        now,
      );
      return reservationResponse(
        await tx.reservation.create({
          data: {
            code,
            customerId: dto.customerId,
            commercialItemId: dto.commercialItemId,
            reservationAt: at,
            numberOfPeople: dto.numberOfPeople,
            notes: dto.notes,
            status: ReservationStatus.CONFIRMED,
            createdAt: now,
            // No aceptar reservationRequestId aquí: no es un flujo de aprobación.
          },
          select: reservationSelect,
        }),
      );
    });
  }

  async findAll(query: ReservationQueryDto) {
    if (
      query.excludeCancelled &&
      query.status === ReservationStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'No combines status=CANCELLED con excludeCancelled=true',
      );
    }
    const search = query.search;
    const digits = search?.replace(/\D/g, '');
    const where: Prisma.ReservationWhereInput = {
      reservationAt: reservationDateRange(query.dateFrom, query.dateTo),
      status:
        query.status ??
        (query.excludeCancelled
          ? { not: ReservationStatus.CANCELLED }
          : undefined),
      customerId: query.customerId,
      commercialItemId: query.commercialItemId,
      assignedUserId: query.assignedUserId,
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: 'insensitive' } },
              {
                customer: {
                  firstName: { contains: search, mode: 'insensitive' },
                },
              },
              {
                customer: {
                  lastName: { contains: search, mode: 'insensitive' },
                },
              },
              { customer: { phone: { contains: search } } },
              ...(digits
                ? [{ customer: { normalizedPhone: { contains: digits } } }]
                : []),
            ],
          }
        : {}),
    };
    const { page = 1, limit = 20 } = query;
    // El calendario solo consulta Reservation; jamás ReservationRequest.
    const [data, total] = await Promise.all([
      this.prisma.reservation.findMany({
        where,
        select: reservationSelect,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ reservationAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.reservation.count({ where }),
    ]);
    return {
      data: data.map(reservationResponse),
      pagination: bookingPagination(page, limit, total),
    };
  }

  async findOne(id: string) {
    const row = await this.prisma.reservation.findUnique({
      where: { id },
      select: reservationDetailSelect,
    });
    if (!row) throw new NotFoundException('Reserva no encontrada');
    return reservationResponse(row);
  }

  update(id: string, dto: UpdateReservationDto, actor: AuthenticatedUser) {
    requireNonemptyPatch(dto);
    return this.support.transaction(async (tx) => {
      const current = await tx.reservation.findUnique({
        where: { id },
        select: reservationSelect,
      });
      if (!current) throw new NotFoundException('Reserva no encontrada');
      requireReservationEditable(current.status);
      if (dto.customerId !== undefined && dto.customerId !== current.customerId)
        await this.support.customer(tx, dto.customerId);
      if (
        dto.commercialItemId !== undefined &&
        dto.commercialItemId !== current.commercialItemId
      )
        await this.support.commercialItem(tx, dto.commercialItemId);
      const schedule =
        dto.reservationAt === undefined
          ? {}
          : await this.recordReschedule(
              tx,
              current,
              dto.reservationAt,
              actor.id,
            );
      return reservationResponse(
        await tx.reservation.update({
          where: { id },
          data: {
            customerId: dto.customerId,
            commercialItemId: dto.commercialItemId,
            ...schedule,
            numberOfPeople: dto.numberOfPeople,
            notes: dto.notes,
          },
          select: reservationSelect,
        }),
      );
    });
  }

  updateStatus(id: string, dto: UpdateReservationStatusDto) {
    return this.support.transaction(async (tx) => {
      const current = await tx.reservation.findUnique({
        where: { id },
        select: reservationSelect,
      });
      if (!current) throw new NotFoundException('Reserva no encontrada');
      requireReservationTransition(
        current.status,
        dto.status,
        current.reservationAt,
      );
      if (current.status === dto.status) return reservationResponse(current);
      return reservationResponse(
        await tx.reservation.update({
          where: { id },
          data: { status: dto.status },
          select: reservationSelect,
        }),
      );
    });
  }

  reschedule(
    id: string,
    dto: RescheduleReservationDto,
    actor: AuthenticatedUser,
  ) {
    return this.support.transaction(async (tx) => {
      const current = await this.requireReservation(tx, id);
      requireReservationEditable(current.status);
      const data = await this.recordReschedule(
        tx,
        current,
        dto.reservationAt,
        actor.id,
        dto.reason,
      );
      if (Object.keys(data).length === 0) return reservationResponse(current);
      return reservationResponse(
        await tx.reservation.update({
          where: { id },
          data,
          select: reservationSelect,
        }),
      );
    });
  }

  assign(id: string, dto: AssignReservationDto, actor: AuthenticatedUser) {
    return this.support.transaction(async (tx) => {
      const current = await this.requireReservation(tx, id);
      requireReservationAssignable(current.status);
      if (!actor.roles.includes(RoleCode.ADMIN)) {
        if (
          !actor.roles.includes(RoleCode.OPERATOR) ||
          (dto.assignedUserId !== null && dto.assignedUserId !== actor.id) ||
          (current.assignedUserId !== null &&
            current.assignedUserId !== actor.id)
        ) {
          throw new ForbiddenException(
            'Un operador solo puede tomar una reserva libre o gestionar su propia asignación',
          );
        }
      }
      if (dto.assignedUserId !== null) {
        const user = await tx.user.findUnique({
          where: { id: dto.assignedUserId },
          select: {
            isActive: true,
            roles: { select: { role: { select: { code: true } } } },
          },
        });
        if (!user) throw new NotFoundException('Responsable no encontrado');
        if (
          !user.isActive ||
          !user.roles.some(
            ({ role }) =>
              role.code === RoleCode.OPERATOR || role.code === RoleCode.ADMIN,
          )
        ) {
          throw new BadRequestException(
            'El responsable debe estar activo y tener rol OPERATOR o ADMIN',
          );
        }
      }
      if (current.assignedUserId === dto.assignedUserId)
        return reservationResponse(current);
      return reservationResponse(
        await tx.reservation.update({
          where: { id },
          data: { assignedUserId: dto.assignedUserId },
          select: reservationSelect,
        }),
      );
    });
  }

  addNote(id: string, dto: CreateReservationNoteDto, actor: AuthenticatedUser) {
    return this.support.transaction(async (tx) => {
      await this.requireReservation(tx, id);
      return tx.reservationNote.create({
        data: {
          reservationId: id,
          authorUserId: actor.id,
          content: dto.content,
        },
        select: reservationNoteSelect,
      });
    });
  }

  private async requireReservation(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.reservation.findUnique({
      where: { id },
      select: reservationSelect,
    });
    if (!row) throw new NotFoundException('Reserva no encontrada');
    return row;
  }

  private async recordReschedule(
    tx: Prisma.TransactionClient,
    current: ReservationRow,
    value: string,
    actorId: string,
    reason?: string | null,
  ): Promise<{ reservationAt?: Date; status?: ReservationStatus }> {
    const at = futureReservationDate(value);
    if (at.getTime() === current.reservationAt.getTime()) return {};
    // Serializable reintenta releyendo la fecha anterior; el historial y cambio se confirman juntos.
    await tx.reservationRescheduleHistory.create({
      data: {
        reservationId: current.id,
        previousReservationAt: current.reservationAt,
        newReservationAt: at,
        reason,
        changedByUserId: actorId,
      },
    });
    return { reservationAt: at, status: ReservationStatus.RESCHEDULED };
  }
}
// TODO: integrar auditoría funcional; no registrar datos de contacto ni notas en logs.
// Eventos futuros: RESERVATION_ASSIGNED, RESERVATION_NOTE_ADDED, RESERVATION_RESCHEDULED,
// RESERVATION_STATUS_CHANGED, RESERVATION_CANCELLED, RESERVATION_COMPLETED, RESERVATION_NO_SHOW.
