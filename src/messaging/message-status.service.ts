import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MessagingTransactionService } from './messaging-transaction.service';
import type { WhatsAppStatus } from '../whatsapp/whatsapp.adapter';
import type { MessageStatus } from '../../generated/prisma/enums';

export function nextDeliveryStatus(
  current: MessageStatus,
  incoming: WhatsAppStatus['status'],
): MessageStatus {
  // Delivery/read evidence wins over failure. A late sent receipt cannot undo failure.
  if (current === 'READ') return current;
  if (current === 'DELIVERED') return incoming === 'READ' ? 'READ' : current;
  if (incoming === 'READ' || incoming === 'DELIVERED') return incoming;
  if (current === 'FAILED') return current;
  return incoming;
}
@Injectable()
export class MessageStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: MessagingTransactionService,
  ) {}
  async accept(events: WhatsAppStatus[]) {
    if (!events.length) return;
    await this.prisma.messageStatusEvent.createMany({
      data: events.map((event) => ({ ...event, channel: 'WHATSAPP' as const })),
      skipDuplicates: true,
    });
  }
  async reconcileOnce() {
    const rows = await this.prisma.messageStatusEvent.findMany({
      where: { processedAt: null, availableAt: { lte: new Date() } },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    for (const event of rows)
      await this.transactions.run(async (tx) => {
        const message = await tx.message.findFirst({
          where: {
            channel: event.channel,
            externalMessageId: event.externalMessageId,
            providerAccountId: event.providerAccountId,
            direction: 'OUTBOUND',
          },
        });
        if (!message || message.status === 'QUEUED') {
          // Preserve early/orphan receipts. Backoff avoids starving newer events.
          await tx.messageStatusEvent.update({
            where: { id: event.id },
            data: { availableAt: new Date(Date.now() + 60000) },
          });
          return;
        }
        const incoming = event.status as WhatsAppStatus['status'];
        const status = nextDeliveryStatus(message.status, incoming);
        const earliest = (existing: Date | null) =>
          existing && existing < event.occurredAt ? existing : event.occurredAt;
        await tx.message.update({
          where: { id: message.id },
          data: {
            status,
            sentAt:
              incoming !== 'FAILED' ? earliest(message.sentAt) : message.sentAt,
            deliveredAt:
              incoming === 'DELIVERED' || incoming === 'READ'
                ? earliest(message.deliveredAt)
                : message.deliveredAt,
            providerReadAt:
              incoming === 'READ'
                ? earliest(message.providerReadAt)
                : message.providerReadAt,
            failedAt:
              status === 'FAILED'
                ? incoming === 'FAILED'
                  ? earliest(message.failedAt)
                  : message.failedAt
                : null,
            errorCode: status === 'FAILED' ? 'WHATSAPP_DELIVERY_FAILED' : null,
            errorReason: null,
            processingToken: null,
            processingUntil: null,
          },
        });
        await tx.messagingOutbox.updateMany({
          where: { messageId: message.id },
          data: {
            status: status === 'FAILED' ? 'FAILED' : 'COMPLETED',
            completedAt: new Date(),
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode:
              status === 'FAILED' ? 'WHATSAPP_DELIVERY_FAILED' : null,
          },
        });
        await tx.messageStatusEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
      });
  }
}
