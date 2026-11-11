import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  ReservationRequestStatus,
  ReservationStatus,
} from '../../generated/prisma/enums';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import {
  CreateReservationRequestDto,
  RejectReservationRequestDto,
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
  requireRequestApprovable,
  requireRequestEditable,
  requireRequestRejectable,
  reservationDateRange,
} from '../reservations/reservation-rules';
import {
  reservationRequestDetailSelect,
  reservationRequestSelect,
  reservationResponse,
  reservationSelect,
} from '../reservations/reservation.select';
import {
  recordRequestStatusChange,
  userActor,
  type RequestStatusActor,
} from '../reservations/reservation-request-history';
import { serializeMoney } from '../commercial/commercial.utils';

const response = <T extends { quotedPrice: Prisma.Decimal | null }>(
  row: T,
) => ({
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
      if (dto.conversationId)
        await this.conversation(tx, dto.conversationId, dto.customerId);
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
            conversationId: dto.conversationId,
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
      conversationId: query.conversationId,
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
      select: reservationRequestDetailSelect,
    });
    if (!row) throw new NotFoundException('Solicitud de reserva no encontrada');
    return response(row);
  }

  update(
    id: string,
    dto: UpdateReservationRequestDto,
    actor: Pick<AuthenticatedUser, 'id'>,
  ) {
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
      // The linked conversation must stay with the request's customer, also when only
      // the customer changes.
      const customerId = dto.customerId ?? current.customerId;
      const conversationId =
        dto.conversationId === undefined
          ? current.conversationId
          : dto.conversationId;
      if (
        conversationId !== null &&
        (conversationId !== current.conversationId ||
          customerId !== current.customerId)
      )
        await this.conversation(tx, conversationId, customerId);
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
      const updated = await tx.reservationRequest.update({
        where: { id },
        data: {
          customerId: dto.customerId,
          commercialItemId: dto.commercialItemId,
          conversationId: dto.conversationId,
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
      });
      // Completing or removing the date or the party size moves the request between
      // INCOMPLETE_DATA and READY_TO_SEND.
      await recordRequestStatusChange(tx, {
        requestId: id,
        previousStatus: current.status,
        newStatus: updated.status,
        actor: userActor(actor),
      });
      return response(updated);
    });
  }

  updateStatus(
    id: string,
    dto: UpdateReservationRequestStatusDto,
    actor: Pick<AuthenticatedUser, 'id'>,
  ) {
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
      const updated = await tx.reservationRequest.update({
        where: { id },
        data: { status: ReservationRequestStatus.CANCELLED },
        select: reservationRequestSelect,
      });
      await recordRequestStatusChange(tx, {
        requestId: id,
        previousStatus: current.status,
        newStatus: updated.status,
        actor: userActor(actor),
        reason: dto.reason,
      });
      return response(updated);
    });
  }

  // A person (OWNER or ADMIN) approves the request: it becomes ACCEPTED and its calendar
  // reservation (CONFIRMED) is created from its data, both in one transaction. Approving
  // again returns the same reservation; the unique reservationRequestId keeps it to one
  // even under concurrent approvals (the losing transaction retries and sees ACCEPTED).
  approve(id: string, actor: Pick<AuthenticatedUser, 'id'>) {
    return this.support.transaction((tx) =>
      this.approveIn(tx, id, userActor(actor)),
    );
  }

  // The approval itself, inside a transaction the caller owns: the owner's WhatsApp
  // answer (M9.2) uses it with actorType OWNER in the transaction that processes the
  // message. Every check runs before the first write, so a refusal (an HttpException)
  // leaves the caller's transaction usable.
  async approveIn(
    tx: Prisma.TransactionClient,
    id: string,
    actor: RequestStatusActor,
  ) {
    const current = await tx.reservationRequest.findUnique({
      where: { id },
      select: {
        ...reservationRequestSelect,
        reservation: { select: reservationSelect },
      },
    });
    if (!current)
      throw new NotFoundException('Solicitud de reserva no encontrada');
    const { reservation: existing, ...request } = current;
    if (request.status === ReservationRequestStatus.ACCEPTED && existing)
      return {
        request: response(request),
        reservation: reservationResponse(existing),
      };
    requireRequestApprovable(request.status);
    const at = request.reservationAt;
    const people = request.numberOfPeople;
    // READY_TO_SEND guarantees both (SQL check); later states keep them.
    if (!at || !people)
      throw new ConflictException(
        'Completa la fecha y el número de personas antes de aprobar la solicitud',
      );
    const now = new Date();
    if (at <= now)
      throw new ConflictException(
        'La fecha de la solicitud ya pasó: edítala antes de aprobarla',
      );
    // Same rule as a reservation created by hand.
    await this.support.commercialItem(tx, request.commercialItemId);
    const config = await this.support.configuration(tx);
    const code = await this.support.code(
      tx,
      'reservation',
      config.timeZone,
      now,
    );
    const reservation = await tx.reservation.create({
      data: {
        code,
        reservationRequestId: id,
        customerId: request.customerId,
        commercialItemId: request.commercialItemId,
        reservationAt: at,
        numberOfPeople: people,
        // What the customer asked for (table, high chair...) is what staff prepare.
        notes: request.specialRequirements,
        status: ReservationStatus.CONFIRMED,
        createdAt: now,
      },
      select: reservationSelect,
    });
    const updated = await tx.reservationRequest.update({
      where: { id },
      data: { status: ReservationRequestStatus.ACCEPTED },
      select: reservationRequestSelect,
    });
    await recordRequestStatusChange(tx, {
      requestId: id,
      previousStatus: request.status,
      newStatus: updated.status,
      actor,
    });
    return {
      request: response(updated),
      reservation: reservationResponse(reservation),
    };
  }

  // A person (OWNER or ADMIN) rejects the request: REJECTED, with the reason in its
  // history. No reservation and no renegotiation. Rejecting again changes nothing.
  reject(
    id: string,
    dto: RejectReservationRequestDto,
    actor: Pick<AuthenticatedUser, 'id'>,
  ) {
    return this.support.transaction((tx) =>
      this.rejectIn(tx, id, dto.reason, userActor(actor)),
    );
  }

  // The rejection inside a transaction the caller owns (see approveIn).
  async rejectIn(
    tx: Prisma.TransactionClient,
    id: string,
    reason: string | null | undefined,
    actor: RequestStatusActor,
  ) {
    const current = await tx.reservationRequest.findUnique({
      where: { id },
      select: reservationRequestSelect,
    });
    if (!current)
      throw new NotFoundException('Solicitud de reserva no encontrada');
    if (current.status === ReservationRequestStatus.REJECTED)
      return response(current);
    requireRequestRejectable(current.status);
    const updated = await tx.reservationRequest.update({
      where: { id },
      data: { status: ReservationRequestStatus.REJECTED },
      select: reservationRequestSelect,
    });
    await recordRequestStatusChange(tx, {
      requestId: id,
      previousStatus: current.status,
      newStatus: updated.status,
      actor,
      reason,
    });
    return response(updated);
  }

  private async conversation(
    tx: Prisma.TransactionClient,
    id: string,
    customerId: string,
  ) {
    const conversation = await tx.conversation.findUnique({
      where: { id },
      select: { customerId: true },
    });
    if (!conversation)
      throw new NotFoundException('Conversación no encontrada');
    if (conversation.customerId !== customerId)
      throw new BadRequestException('La conversación pertenece a otro cliente');
  }

  private validateQuote(price: Prisma.Decimal | null, currency: string | null) {
    if ((price === null) !== (currency === null))
      throw new BadRequestException(
        'El precio y la moneda deben estar presentes juntos',
      );
  }
}
// La aceptación futura debe actualizar la solicitud, registrar su historial
// (recordRequestStatusChange) y crear su reserva en una sola transacción.
