import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';

@Injectable()
export class SamantaContextService {
  async knowledge(tx: Prisma.TransactionClient) {
    const restaurant = await tx.restaurantConfig.findUnique({
      where: { scope: 'GLOBAL' },
      select: {
        businessName: true,
        description: true,
        address: true,
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
    const items = await tx.commercialItem.findMany({
      where: {
        isActive: true,
        approvalStatus: 'APPROVED',
        category: { isActive: true },
      },
      take: 31,
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
    const data = {
      restaurant,
      catalogue: items.slice(0, 30),
      catalogueHasMore: items.length > 30,
      catalogueIsComplete: false,
      liveAvailabilityKnown: false,
    };
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, 'utf8') > 32000)
      throw new ConflictException(
        'Contexto comercial demasiado extenso; requiere revisión manual',
      );
    return { data, hash: createHash('sha256').update(json).digest('hex') };
  }
  async build(tx: Prisma.TransactionClient, conversationId: string) {
    const knowledge = await this.knowledge(tx);
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
      take: 10,
      select: { direction: true, type: true, content: true },
    });
    // No contact record, phone, credentials, internal notes or other conversations.
    const context = JSON.stringify({
      ...knowledge.data,
      nowUtc: new Date().toISOString(),
      history: history.reverse().map((row) => ({
        ...row,
        content: row.content?.slice(0, 4096) ?? null,
      })),
    });
    if (Buffer.byteLength(context, 'utf8') > 48000)
      throw new ConflictException(
        'Historial demasiado extenso; requiere revisión manual',
      );
    return { context, hash: knowledge.hash };
  }
}
