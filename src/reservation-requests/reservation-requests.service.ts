import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ReservationRequestStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import {
  CreateReservationRequestDto,
  ReservationRequestQueryDto,
  UpdateReservationRequestDto,
  UpdateReservationRequestStatusDto,
} from '../dto/reservation-request.dto';
import { ReservationSupportService } from '../reservations/reservation-support.service';
import {
  bookingPagination,
  futureReservationDate,
  requestCompleteness,
  requireNonemptyPatch,
  requireRequestEditable,
  reservationDateRange,
} from '../reservations/reservation-rules';
import { reservationRequestSelect } from '../reservations/reservation.select';
import { serializeMoney } from '../commercial/commercial.utils';

type RequestRow = Prisma.ReservationRequestGetPayload<{
  select: typeof reservationRequestSelect;
}>;
const response = (row: RequestRow) => ({
  ...row,
  quotedPrice: serializeMoney(row.quotedPrice),
});

@Injectable()
export class ReservationRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly support: ReservationSupportService,
  ) {}

  create(dto: CreateReservationRequestDto) {
    return this.support.transaction(async (tx) => {
      const config = await this.support.configuration(tx);
      await this.support.customer(tx, dto.customerId);
      await this.support.commercialItem(tx, dto.commercialItemId);
      const at =
        dto.reservationAt == null
          ? null
          : futureReservationDate(dto.reservationAt);
      const people = dto.numberOfPeople ?? null;
      const quotedPrice =
        dto.quotedPrice == null ? null : new Prisma.Decimal(dto.quotedPrice);
      const currency =
        quotedPrice === null
          ? (dto.currency ?? null)
          : dto.currency === undefined
            ? config.currency
            : dto.currency;
      this.validateQuote(quotedPrice, currency);
      const now = new Date();
      const code = await this.support.code(tx, 'request', config.timeZone, now);
      return response(
        await tx.reservationRequest.create({
          data: {
            code,
            customerId: dto.customerId,
            commercialItemId: dto.commercialItemId,
            sourceChannel: dto.sourceChannel,
            reservationAt: at,
            numberOfPeople: people,
            quotedPrice,
            currency,
            comments: dto.comments,
            specialRequirements: dto.specialRequirements,
            status: requestCompleteness(at, people),
            createdAt: now,
          },
          select: reservationRequestSelect,
        }),
      );
    });
  }

  async findAll(query: ReservationRequestQueryDto) {
    const range = reservationDateRange(query.dateFrom, query.dateTo);
    const search = query.search;
    const digits = search?.replace(/\D/g, '');
    const where: Prisma.ReservationRequestWhereInput = {
      status: query.status,
      customerId: query.customerId,
      commercialItemId: query.commercialItemId,
      sourceChannel: query.channel,
      reservationAt: range,
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
    const [rows, total] = await Promise.all([
      this.prisma.reservationRequest.findMany({
        where,
        select: reservationRequestSelect,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.reservationRequest.count({ where }),
    ]);
    return {
      data: rows.map(response),
      pagination: bookingPagination(page, limit, total),
    };
  }

  async findOne(id: string) {
    const row = await this.prisma.reservationRequest.findUnique({
      where: { id },
      select: reservationRequestSelect,
    });
    if (!row) throw new NotFoundException('Solicitud de reserva no encontrada');
    return response(row);
  }

  update(id: string, dto: UpdateReservationRequestDto) {
    requireNonemptyPatch(dto);
    return this.support.transaction(async (tx) => {
      const current = await tx.reservationRequest.findUnique({
        where: { id },
        select: reservationRequestSelect,
      });
      if (!current)
        throw new NotFoundException('Solicitud de reserva no encontrada');
      requireRequestEditable(current.status);
      if (dto.customerId !== undefined && dto.customerId !== current.customerId)
        await this.support.customer(tx, dto.customerId);
      if (
        dto.commercialItemId !== undefined &&
        dto.commercialItemId !== current.commercialItemId
      )
        await this.support.commercialItem(tx, dto.commercialItemId);
      const at =
        dto.reservationAt === undefined
          ? current.reservationAt
          : dto.reservationAt === null
            ? null
            : futureReservationDate(dto.reservationAt);
      const people =
        dto.numberOfPeople === undefined
          ? current.numberOfPeople
          : dto.numberOfPeople;
      const quotedPrice =
        dto.quotedPrice === undefined
          ? current.quotedPrice
          : dto.quotedPrice === null
            ? null
            : new Prisma.Decimal(dto.quotedPrice);
      let currency =
        dto.currency === undefined ? current.currency : dto.currency;
      if (dto.quotedPrice === null && dto.currency === undefined)
        currency = null;
      if (
        quotedPrice !== null &&
        currency === null &&
        dto.currency === undefined
      )
        currency = (await this.support.configuration(tx)).currency;
      this.validateQuote(quotedPrice, currency);
      return response(
        await tx.reservationRequest.update({
          where: { id },
          data: {
            customerId: dto.customerId,
            commercialItemId: dto.commercialItemId,
            sourceChannel: dto.sourceChannel,
            reservationAt: at,
            numberOfPeople: people,
            quotedPrice,
            currency,
            comments: dto.comments,
            specialRequirements: dto.specialRequirements,
            status: requestCompleteness(at, people),
          },
          select: reservationRequestSelect,
        }),
      );
    });
  }

  updateStatus(id: string, dto: UpdateReservationRequestStatusDto) {
    if (dto.status !== ReservationRequestStatus.CANCELLED)
      throw new BadRequestException(
        'Solo se permite cancelar solicitudes en esta fase',
      );
    return this.support.transaction(async (tx) => {
      const current = await tx.reservationRequest.findUnique({
        where: { id },
        select: reservationRequestSelect,
      });
      if (!current)
        throw new NotFoundException('Solicitud de reserva no encontrada');
      if (current.status === ReservationRequestStatus.CANCELLED)
        return response(current);
      requireRequestEditable(current.status);
      return response(
        await tx.reservationRequest.update({
          where: { id },
          data: { status: ReservationRequestStatus.CANCELLED },
          select: reservationRequestSelect,
        }),
      );
    });
  }

  private validateQuote(price: Prisma.Decimal | null, currency: string | null) {
    if ((price === null) !== (currency === null))
      throw new BadRequestException(
        'El precio y la moneda deben estar presentes juntos',
      );
  }
}
// TODO: integrar auditoría funcional y Conversation cuando exista su infraestructura.
// La aceptación futura debe actualizar la solicitud y crear su reserva en una sola transacción.
