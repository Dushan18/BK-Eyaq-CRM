import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { MessagingTransactionService } from './messaging-transaction.service';
import { messageSelect } from './messaging.select';
import {
  MESSAGE_ATTEMPTS,
  MESSAGE_LEASE_MS,
} from './message-processor.service';
import type { OutboundMessageDto } from './outbound-message.dto';
import {
  ChannelSendError,
  ChannelTransports,
  isRetryableSendError,
  type ChannelTransport,
} from './channel-transport';

// Meta's customer service window, shared by WhatsApp and Messenger.
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
@Injectable()
export class OutboundMessagesService {
  private readonly logger = new Logger(OutboundMessagesService.name);
  constructor(
    private readonly transactions: MessagingTransactionService,
    private readonly transports: ChannelTransports,
  ) {}
  async queueOutboundMessage(
    conversationId: string,
    authorUserId: string,
    key: string | undefined,
    dto: OutboundMessageDto,
    transaction?: Prisma.TransactionClient,
  ) {
    if (!key || !/^[a-zA-Z0-9_-]{16,80}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key debe contener 16 a 80 caracteres alfanuméricos, guion o guion bajo',
      );
    const enqueue = async (tx: Prisma.TransactionClient) => {
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
        include: {
          customer: {
            select: {
              normalizedPhone: true,
              providerAccountId: true,
              externalContactId: true,
            },
          },
        },
      });
      if (!conversation)
        throw new NotFoundException('Conversación no encontrada');
      const transport = this.transports.find(conversation.channel);
      if (!transport)
        throw new BadRequestException(
          'Conversación sin destinatario habilitado',
        );
      transport.assertEnabled();
      if (dto.content.length > transport.maxTextLength)
        throw new BadRequestException(
          `${transport.label} admite hasta ${transport.maxTextLength} caracteres por respuesta`,
        );
      const recipient = transport.recipientOf(conversation.customer);
      if (!recipient)
        throw new BadRequestException(
          'Conversación sin destinatario habilitado',
        );
      if (!(await this.windowOpen(tx, conversationId, transport, recipient)))
        throw new ConflictException(transport.windowClosedMessage);
      const current = await tx.conversation.update({
        where: { id: conversationId },
        data: { lastSequence: { increment: 1 }, lastMessageAt: new Date() },
      });
      return tx.message.create({
        data: {
          conversationId,
          channel: transport.channel,
          sequence: current.lastSequence,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          type: dto.type,
          content: dto.content,
          authorUserId,
          idempotencyKey: key,
          ...this.address(transport, recipient),
          providerAccountId: transport.providerAccountId,
          outbox: { create: {} },
        },
        select: messageSelect,
      });
    };
    return transaction
      ? enqueue(transaction)
      : this.transactions.run(enqueue, true);
  }
  private address(transport: ChannelTransport, recipient: string) {
    return transport.recipientField === 'recipientPhone'
      ? { recipientPhone: recipient, recipientExternalId: null }
      : { recipientPhone: null, recipientExternalId: recipient };
  }
  private async windowOpen(
    tx: Prisma.TransactionClient,
    conversationId: string,
    transport: ChannelTransport,
    recipient: string,
  ) {
    const latest = await tx.message.findFirst({
      where: {
        conversationId,
        [transport.recipientField]: recipient,
        providerAccountId: transport.providerAccountId,
        direction: 'INBOUND',
        channel: transport.channel,
        occurredAt: {
          gte: new Date(Date.now() - SERVICE_WINDOW_MS),
          lte: new Date(),
        },
      },
      orderBy: { occurredAt: 'desc' },
      select: { id: true },
    });
    return !!latest;
  }
  async process(messageId: string): Promise<'processed' | 'terminal' | 'busy'> {
    if (!this.transports.anyEnabled) return 'busy';
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
      const transport = this.transports.find(message.channel);
      if (transport && !transport.enabled) return 'busy' as const;
      const prefix = this.transports.errorPrefix(message.channel);
      if (message.status === 'SENDING') {
        if (message.processingUntil && message.processingUntil > new Date())
          return 'busy' as const;
        // A dead worker might have sent already. Expired leases are NOT permission to resend.
        await this.finish(tx, messageId, 'UNKNOWN', `${prefix}_SEND_UNKNOWN`);
        return 'terminal' as const;
      }
      if (
        message.outbox?.status === 'PENDING' &&
        message.outbox.availableAt > new Date()
      )
        return 'busy' as const;
      const recipient = transport ? message[transport.recipientField] : null;
      if (
        !transport ||
        message.processingAttempts >= MESSAGE_ATTEMPTS ||
        message.type !== 'TEXT' ||
        !message.content ||
        !recipient ||
        message.content.length > transport.maxTextLength ||
        message.providerAccountId !== transport.providerAccountId
      ) {
        await this.finish(tx, messageId, 'FAILED', `${prefix}_SEND_INVALID`);
        return 'terminal' as const;
      }
      if (
        !(await this.windowOpen(
          tx,
          message.conversationId,
          transport,
          recipient,
        ))
      ) {
        await this.finish(tx, messageId, 'FAILED', `${prefix}_WINDOW_CLOSED`);
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
    // The claim only succeeds for a channel with an enabled transport.
    const transport = this.transports.find(claimed.channel)!;
    const prefix = transport.errorPrefix;
    // Never include the external POST inside a retried database transaction.
    let externalMessageId: string | undefined;
    let failure: ChannelSendError | undefined;
    try {
      externalMessageId = await transport.sendMessage(
        claimed[transport.recipientField]!,
        claimed.content!,
      );
    } catch (error) {
      failure =
        error instanceof ChannelSendError
          ? error
          : new ChannelSendError('unknown');
      if (failure.diagnostic) {
        this.logger.warn(
          JSON.stringify({
            code: `${prefix}_SEND_HTTP_ERROR`,
            messageId: claimed.id,
            outcome: failure.outcome,
            httpStatus: failure.diagnostic.httpStatus,
            metaCode: failure.diagnostic.metaCode,
            metaSubcode: failure.diagnostic.metaSubcode,
            isTransient: failure.diagnostic.isTransient,
          }),
        );
      }
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
        isRetryableSendError(failure) &&
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
            errorCode: `${prefix}_RATE_LIMITED`,
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
          ? `${prefix}_SEND_UNKNOWN`
          : `${prefix}_SEND_REJECTED`,
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
