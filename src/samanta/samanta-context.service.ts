import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { CRM_NOTE } from '../common/crm-note';

const KNOWLEDGE_LIMIT = 32000;
const CONTEXT_LIMIT = 48000;
const CATALOGUE_SIZE = 30;
const HISTORY_SIZE = 20;
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');
// An open request without a date stops being "pending" after this.
const PENDING_UNDATED_MS = 30 * 24 * 60 * 60 * 1000;

// What a member of the public typed in the web form (preference and message), as data
// for the model: without the CRM's own notes, links, emails or phone numbers, so the
// form cannot make Samanta repeat them to whoever owns the number it gave.
export function formNotes(...parts: (string | null)[]) {
  const text = parts
    .filter(Boolean)
    .join('\n')
    .slice(0, 1000)
    .split('\n')
    .filter((line) => !line.startsWith(CRM_NOTE))
    .join('\n')
    .replace(/\b(?:https?:\/\/|www\.)\S*/gi, '[enlace]')
    .replace(/[^\s@]+@[^\s@]+/g, '[correo]')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[número]')
    .trim();
  return text ? text.slice(0, 300) : null;
}

// "2026-11-08 21:30" and "domingo" in the restaurant's time zone.
export function localTime(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('es-PE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'long',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
    weekday: parts.weekday,
  };
}

@Injectable()
export class SamantaContextService {
  async knowledge(tx: Prisma.TransactionClient) {
    const restaurant = await tx.restaurantConfig.findUnique({
      where: { scope: 'GLOBAL' },
      select: {
        businessName: true,
        description: true,
        address: true,
        latitude: true,
        longitude: true,
        whatsappNumber: true,
        email: true,
        website: true,
        currency: true,
        timeZone: true,
        reservationPolicy: true,
        cancellationPolicy: true,
        languages: { select: { language: true }, orderBy: { language: 'asc' } },
        schedules: {
          select: {
            dayOfWeek: true,
            isOpen: true,
            openTime: true,
            closeTime: true,
          },
          orderBy: { dayOfWeek: 'asc' },
        },
      },
    });
    if (!restaurant)
      throw new ConflictException(
        'Configura el restaurante antes de usar Samanta',
      );
    const now = new Date();
    const items = await tx.commercialItem.findMany({
      where: {
        isActive: true,
        approvalStatus: 'APPROVED',
        category: { isActive: true },
        // Expired promotions and past events must not be offered.
        AND: [
          {
            OR: [
              { promotionDetail: { is: null } },
              {
                promotionDetail: {
                  is: {
                    OR: [{ validUntil: null }, { validUntil: { gte: now } }],
                  },
                },
              },
            ],
          },
          {
            OR: [
              { eventDetail: { is: null } },
              {
                eventDetail: {
                  is: { OR: [{ endAt: null }, { endAt: { gte: now } }] },
                },
              },
            ],
          },
        ],
      },
      take: CATALOGUE_SIZE + 1,
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      select: {
        nameEs: true,
        nameEn: true,
        type: true,
        descriptionEs: true,
        descriptionEn: true,
        basePrice: true,
        conditions: true,
        availabilityNote: true,
        category: { select: { nameEs: true, nameEn: true } },
        variants: {
          where: { isActive: true },
          take: 10,
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          select: {
            nameEs: true,
            nameEn: true,
            descriptionEs: true,
            descriptionEn: true,
            price: true,
          },
        },
        faqs: {
          take: 10,
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          select: {
            questionEs: true,
            questionEn: true,
            answerEs: true,
            answerEn: true,
          },
        },
        schedules: {
          orderBy: { dayOfWeek: 'asc' },
          select: {
            dayOfWeek: true,
            isAvailable: true,
            startTime: true,
            endTime: true,
          },
        },
        promotionDetail: {
          select: { validFrom: true, validUntil: true, promotionalPrice: true },
        },
        eventDetail: { select: { startAt: true, endAt: true } },
      },
    });
    const { latitude, longitude, ...business } = restaurant;
    const data = {
      restaurant: {
        ...business,
        mapsUrl:
          latitude && longitude
            ? `https://www.google.com/maps?q=${latitude.toString()},${longitude.toString()}`
            : null,
      },
      catalogue: items.slice(0, CATALOGUE_SIZE),
      catalogueHasMore: items.length > CATALOGUE_SIZE,
      catalogueIsComplete: false,
      liveAvailabilityKnown: false,
    };
    // A large catalogue must not block Samanta everywhere: send what fits.
    while (bytes(data) > KNOWLEDGE_LIMIT && data.catalogue.length) {
      data.catalogue = data.catalogue.slice(0, -1);
      data.catalogueHasMore = true;
    }
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, 'utf8') > KNOWLEDGE_LIMIT)
      throw new ConflictException(
        'Contexto comercial demasiado extenso; requiere revisión manual',
      );
    return { data, hash: createHash('sha256').update(json).digest('hex') };
  }
  async build(
    tx: Prisma.TransactionClient,
    conversationId: string,
    maxCharacters: number,
  ) {
    const knowledge = await this.knowledge(tx);
    const { timeZone } = knowledge.data.restaurant;
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        channel: true,
        customerId: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    });
    const now = new Date();
    // Requests the customer already made (e.g. on the website): Samanta confirms them
    // instead of asking for the data again. Only open ones without a reservation yet,
    // not in the past; one without a date only while it is recent.
    const pending = await tx.reservationRequest.findMany({
      where: {
        customerId: conversation.customerId,
        status: {
          in: [
            'INCOMPLETE_DATA',
            'READY_TO_SEND',
            'SENT_TO_OWNER',
            'WAITING_RESPONSE',
            'MODIFICATION_REQUESTED',
            'RENEGOTIATING',
          ],
        },
        reservation: { is: null },
        OR: [
          { reservationAt: { gt: now } },
          {
            reservationAt: null,
            createdAt: { gte: new Date(now.getTime() - PENDING_UNDATED_MS) },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      select: {
        code: true,
        externalReference: true,
        sourceChannel: true,
        reservationAt: true,
        numberOfPeople: true,
        specialRequirements: true,
        comments: true,
      },
    });
    // Reservations the restaurant already confirmed: a request for the same date is
    // confirmed, not pending.
    const upcoming = await tx.reservation.findMany({
      where: {
        customerId: conversation.customerId,
        status: { in: ['CONFIRMED', 'UPCOMING', 'RESCHEDULED'] },
        reservationAt: { gt: now },
      },
      orderBy: [{ reservationAt: 'asc' }, { id: 'asc' }],
      take: 3,
      select: { code: true, reservationAt: true, numberOfPeople: true },
    });
    const history = await tx.message.findMany({
      where: {
        conversationId,
        OR: [
          { direction: 'INBOUND' },
          {
            direction: 'OUTBOUND',
            status: { in: ['SENT', 'DELIVERED', 'READ'] },
          },
        ],
      },
      orderBy: { sequence: 'desc' },
      take: HISTORY_SIZE,
      select: {
        direction: true,
        type: true,
        content: true,
        occurredAt: true,
        createdAt: true,
      },
    });
    const name = [
      conversation.customer.firstName,
      conversation.customer.lastName,
    ]
      .filter(Boolean)
      .join(' ');
    // Only the customer's name and open requests: no phone, email, internal notes or
    // other conversations.
    const context = {
      ...knowledge.data,
      now: { utc: now.toISOString(), timeZone, ...localTime(now, timeZone) },
      reply: { channel: conversation.channel, maxCharacters },
      customer: {
        name: name || null,
        pendingReservations: pending.map((request) => ({
          code: request.externalReference ?? request.code,
          channel: request.sourceChannel,
          at: request.reservationAt
            ? localTime(request.reservationAt, timeZone)
            : null,
          people: request.numberOfPeople,
          // Staff notes are internal; only what the customer typed in the web form.
          formNotes:
            request.sourceChannel === 'WEBSITE'
              ? formNotes(request.specialRequirements, request.comments)
              : null,
        })),
        upcomingReservations: upcoming.map((reservation) => ({
          code: reservation.code,
          at: localTime(reservation.reservationAt, timeZone),
          people: reservation.numberOfPeople,
        })),
      },
      history: history.reverse().map((row) => ({
        direction: row.direction,
        type: row.type,
        content: row.content?.slice(0, 4096) ?? null,
        at: localTime(row.occurredAt ?? row.createdAt, timeZone).local,
      })),
    };
    // Drop the oldest messages first; the newest one always stays.
    while (bytes(context) > CONTEXT_LIMIT && context.history.length > 1)
      context.history = context.history.slice(1);
    const json = JSON.stringify(context);
    if (Buffer.byteLength(json, 'utf8') > CONTEXT_LIMIT)
      throw new ConflictException(
        'Historial demasiado extenso; requiere revisión manual',
      );
    return { context: json, hash: knowledge.hash };
  }
}
