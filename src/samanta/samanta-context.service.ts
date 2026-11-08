import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';

const KNOWLEDGE_LIMIT = 32000;
const CONTEXT_LIMIT = 48000;
const CATALOGUE_SIZE = 30;
const HISTORY_SIZE = 20;
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

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
        customer: { select: { firstName: true, lastName: true } },
      },
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
    const now = new Date();
    const name = [
      conversation.customer.firstName,
      conversation.customer.lastName,
    ]
      .filter(Boolean)
      .join(' ');
    // Only the customer's name: no phone, email, internal notes or other conversations.
    const context = {
      ...knowledge.data,
      now: { utc: now.toISOString(), timeZone, ...localTime(now, timeZone) },
      reply: { channel: conversation.channel, maxCharacters },
      customer: { name: name || null },
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
