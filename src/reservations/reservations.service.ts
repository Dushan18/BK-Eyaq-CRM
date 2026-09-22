import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { ReservationStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import {
  CreateReservationDto,
  ReservationQueryDto,
  UpdateReservationDto,
  UpdateReservationStatusDto,
} from '../dto/reservation.dto';
import { ReservationSupportService } from './reservation-support.service';
import {
  bookingPagination,
  futureReservationDate,
  requireNonemptyPatch,
  requireReservationTransition,
  reservationDateRange,
} from './reservation-rules';
import { reservationSelect } from './reservation.select';

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
      return tx.reservation.create({
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
      });
    });
  }

  async findAll(query: ReservationQueryDto) {
    const where: Prisma.ReservationWhereInput = {
      reservationAt: reservationDateRange(query.dateFrom, query.dateTo),
      status: query.status,
      customerId: query.customerId,
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
    return { data, pagination: bookingPagination(page, limit, total) };
  }

  async findOne(id: string) {
    const row = await this.prisma.reservation.findUnique({
      where: { id },
      select: reservationSelect,
    });
    if (!row) throw new NotFoundException('Reserva no encontrada');
    return row;
  }

  update(id: string, dto: UpdateReservationDto) {
    requireNonemptyPatch(dto);
    return this.support.transaction(async (tx) => {
      const current = await tx.reservation.findUnique({
        where: { id },
        select: reservationSelect,
      });
      if (!current) throw new NotFoundException('Reserva no encontrada');
      if (current.status !== ReservationStatus.CONFIRMED)
        throw new ConflictException('Solo se editan reservas confirmadas');
      if (dto.customerId !== undefined && dto.customerId !== current.customerId)
        await this.support.customer(tx, dto.customerId);
      if (
        dto.commercialItemId !== undefined &&
        dto.commercialItemId !== current.commercialItemId
      )
        await this.support.commercialItem(tx, dto.commercialItemId);
      return tx.reservation.update({
        where: { id },
        data: {
          customerId: dto.customerId,
          commercialItemId: dto.commercialItemId,
          reservationAt:
            dto.reservationAt === undefined
              ? undefined
              : futureReservationDate(dto.reservationAt),
          numberOfPeople: dto.numberOfPeople,
          notes: dto.notes,
        },
        select: reservationSelect,
      });
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
      if (current.status === dto.status) return current;
      return tx.reservation.update({
        where: { id },
        data: { status: dto.status },
        select: reservationSelect,
      });
    });
  }
}
// TODO: integrar auditoría funcional; no registrar datos de contacto ni notas en logs.
