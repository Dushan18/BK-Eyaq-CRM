import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { WhatsAppConfig } from '../whatsapp/whatsapp.config';
import {
  WhatsAppAdapter,
  WhatsAppSendError,
  isRetryableWhatsAppError,
} from '../whatsapp/whatsapp.adapter';
import { MessagingTransactionService } from './messaging-transaction.service';
import { messageSelect } from './messaging.select';
import {
  MESSAGE_ATTEMPTS,
  MESSAGE_LEASE_MS,
} from './message-processor.service';
import type { OutboundMessageDto } from './outbound-message.dto';

export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
@Injectable()
export class OutboundMessagesService {
  constructor(
    private readonly transactions: MessagingTransactionService,
    private readonly config: WhatsAppConfig,
    private readonly adapter: WhatsAppAdapter,
  ) {}
  async queueOutboundMessage(
    conversationId: string,
    authorUserId: string,
    key: string | undefined,
    dto: OutboundMessageDto,
  ) {
    this.config.assertEnabled();
    if (!key || !/^[a-zA-Z0-9_-]{16,80}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key debe contener 16 a 80 caracteres alfanuméricos, guion o guion bajo',
      );
    return this.transactions.run(async (tx) => {
      const existing = await tx.message.findUnique({
        where: {
          conversationId_idempotencyKey: {
            conversationId,
            idempotencyKey: key,
          },
        },
        select: messageSelect,
      });
      if (existing) {
        if (
          existing.authorUserId !== authorUserId ||
          existing.type !== dto.type ||
          existing.content !== dto.content
        )
          throw new ConflictException(
            'Idempotency-Key ya utilizada con otros datos',
          );
        return existing;
      }
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        include: { customer: { select: { normalizedPhone: true } } },
      });
      if (!conversation)
        throw new NotFoundException('Conversación no encontrada');
      if (
        conversation.channel !== 'WHATSAPP' ||
        !conversation.customer.normalizedPhone
      )
        throw new BadRequestException(
          'Conversación sin destinatario WhatsApp habilitado',
        );
      if (
        !(await this.windowOpen(
          tx,
          conversationId,
          conversation.customer.normalizedPhone,
        ))
      )
        throw new ConflictException(
          'Ventana de WhatsApp cerrada; se requiere una plantilla aprobada',
        );
      const current = await tx.conversation.update({
        where: { id: conversationId },
        data: { lastSequence: { increment: 1 }, lastMessageAt: new Date() },
      });
      return tx.message.create({
        data: {
          conversationId,
          channel: 'WHATSAPP',
          sequence: current.lastSequence,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          type: dto.type,
          content: dto.content,
          authorUserId,
          idempotencyKey: key,
          recipientPhone: conversation.customer.normalizedPhone,
          providerAccountId: this.config.phoneId,
          outbox: { create: {} },
        },
        select: messageSelect,
      });
    }, true);
  }
  private async windowOpen(
    tx: Prisma.TransactionClient,
    conversationId: string,
    recipientPhone: string,
  ) {
    const latest = await tx.message.findFirst({
      where: {
        conversationId,
        recipientPhone,
        providerAccountId: this.config.phoneId,
        direction: 'INBOUND',
        channel: 'WHATSAPP',
        occurredAt: {
          gte: new Date(Date.now() - WHATSAPP_WINDOW_MS),
          lte: new Date(),
        },
      },
      orderBy: { occurredAt: 'desc' },
      select: { id: true },
    });
    return !!latest;
  }
  async process(messageId: string): Promise<'processed' | 'terminal' | 'busy'> {
    if (!this.config.enabled) return 'busy';
    const token = randomUUID();
    const claimed = await this.transactions.run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM messages WHERE id = ${messageId} FOR UPDATE`;
      const message = await tx.message.findUnique({
        where: { id: messageId },
        include: { outbox: true },
      });
      if (
        !message ||
        message.direction !== 'OUTBOUND' ||
        !['QUEUED', 'SENDING'].includes(message.status)
      )
        return 'terminal' as const;
      if (message.status === 'SENDING') {
        if (message.processingUntil && message.processingUntil > new Date())
          return 'busy' as const;
        // A dead worker might have sent already. Expired leases are NOT permission to resend.
        await this.finish(tx, messageId, 'UNKNOWN', 'WHATSAPP_SEND_UNKNOWN');
        return 'terminal' as const;
      }
      if (
        message.outbox?.status === 'PENDING' &&
        message.outbox.availableAt > new Date()
      )
        return 'busy' as const;
      if (
        message.processingAttempts >= MESSAGE_ATTEMPTS ||
        message.channel !== 'WHATSAPP' ||
        message.type !== 'TEXT' ||
        !message.content ||
        !message.recipientPhone ||
        message.providerAccountId !== this.config.phoneId
      ) {
        await this.finish(tx, messageId, 'FAILED', 'WHATSAPP_SEND_INVALID');
        return 'terminal' as const;
      }
      if (
        !(await this.windowOpen(
          tx,
          message.conversationId,
          message.recipientPhone,
        ))
      ) {
        await this.finish(tx, messageId, 'FAILED', 'WHATSAPP_WINDOW_CLOSED');
        return 'terminal' as const;
      }
      return tx.message.update({
        where: { id: messageId },
        data: {
          status: 'SENDING',
          processingToken: token,
          processingUntil: new Date(Date.now() + MESSAGE_LEASE_MS),
          processingAttempts: { increment: 1 },
        },
      });
    });
    if (typeof claimed === 'string') return claimed;
    // Never include the external POST inside a retried database transaction.
    let externalMessageId: string | undefined;
    let failure: WhatsAppSendError | undefined;
    try {
      externalMessageId = await this.adapter.sendMessage(
        claimed.recipientPhone!,
        claimed.content!,
      );
    } catch (error) {
      failure =
        error instanceof WhatsAppSendError
          ? error
          : new WhatsAppSendError('unknown');
    }
    return this.transactions.run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM messages WHERE id = ${messageId} FOR UPDATE`;
      const current = await tx.message.findUniqueOrThrow({
        where: { id: messageId },
      });
      // Can attach a late response after recovery marked UNKNOWN, but never repeat the POST.
      if (current.processingToken !== token && current.status !== 'UNKNOWN')
        return 'terminal' as const;
      if (externalMessageId) {
        await tx.message.update({
          where: { id: messageId },
          data: { externalMessageId },
        });
        await this.finish(tx, messageId, 'SENT');
        return 'processed' as const;
      }
      if (
        isRetryableWhatsAppError(failure) &&
        current.processingAttempts < MESSAGE_ATTEMPTS &&
        current.status === 'SENDING'
      ) {
        const delay =
          Math.max(
            failure.retryAfterMs,
            1000 * 2 ** (current.processingAttempts - 1),
          ) + Math.floor(Math.random() * 500);
        await tx.message.update({
          where: { id: messageId },
          data: {
            status: 'QUEUED',
            processingToken: null,
            processingUntil: null,
            errorCode: 'WHATSAPP_RATE_LIMITED',
          },
        });
        await tx.messagingOutbox.update({
          where: { messageId },
          data: {
            status: 'PENDING',
            availableAt: new Date(Date.now() + delay),
            leaseToken: null,
            leaseUntil: null,
          },
        });
        return 'busy' as const;
      }
      await this.finish(
        tx,
        messageId,
        failure?.outcome === 'unknown' ? 'UNKNOWN' : 'FAILED',
        failure?.outcome === 'unknown'
          ? 'WHATSAPP_SEND_UNKNOWN'
          : 'WHATSAPP_SEND_REJECTED',
      );
      return 'terminal' as const;
    });
  }
  private async finish(
    tx: Prisma.TransactionClient,
    messageId: string,
    status: 'SENT' | 'FAILED' | 'UNKNOWN',
    errorCode: string | null = null,
  ) {
    await tx.message.update({
      where: { id: messageId },
      data: {
        status,
        errorCode,
        errorReason: null,
        sentAt: status === 'SENT' ? new Date() : undefined,
        failedAt: status === 'FAILED' ? new Date() : null,
        processingToken: null,
        processingUntil: null,
      },
    });
    await tx.messagingOutbox.update({
      where: { messageId },
      data: {
        status: status === 'SENT' ? 'COMPLETED' : 'FAILED',
        completedAt: new Date(),
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: errorCode,
      },
    });
  }
}
