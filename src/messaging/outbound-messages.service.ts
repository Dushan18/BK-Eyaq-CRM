import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
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
import { MessengerConfig } from '../messenger/messenger.config';
import { MessengerAdapter } from '../messenger/messenger.adapter';

export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
@Injectable()
export class OutboundMessagesService {
  private readonly logger = new Logger(OutboundMessagesService.name);
  constructor(
    private readonly transactions: MessagingTransactionService,
    private readonly config: WhatsAppConfig,
    private readonly adapter: WhatsAppAdapter,
    @Optional() private readonly messengerConfig?: MessengerConfig,
    @Optional() private readonly messengerAdapter?: MessengerAdapter,
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
      const facebook = conversation.channel === 'FACEBOOK';
      const channel = facebook ? 'FACEBOOK' : 'WHATSAPP';
      if (facebook) {
        if (!this.messengerConfig || !this.messengerAdapter)
          throw new BadRequestException('Messenger no configurado');
        this.messengerConfig.assertEnabled();
        if (dto.content.length > 2000)
          throw new BadRequestException(
            'Messenger admite hasta 2000 caracteres por respuesta',
          );
      } else this.config.assertEnabled();
      const recipient = facebook
        ? conversation.customer.externalContactId
        : conversation.customer.normalizedPhone;
      if (
        !['WHATSAPP', 'FACEBOOK'].includes(conversation.channel) ||
        !recipient ||
        (facebook &&
          conversation.customer.providerAccountId !==
            this.messengerConfig!.pageId)
      )
        throw new BadRequestException(
          'Conversación sin destinatario habilitado',
        );
      if (!(await this.windowOpen(tx, conversationId, recipient, channel)))
        throw new ConflictException(
          facebook
            ? 'Ventana de Messenger cerrada; el cliente debe enviar un nuevo mensaje'
            : 'Ventana de WhatsApp cerrada; se requiere una plantilla aprobada',
        );
      const current = await tx.conversation.update({
        where: { id: conversationId },
        data: { lastSequence: { increment: 1 }, lastMessageAt: new Date() },
      });
      return tx.message.create({
        data: {
          conversationId,
          channel,
          sequence: current.lastSequence,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          type: dto.type,
          content: dto.content,
          authorUserId,
          idempotencyKey: key,
          recipientPhone: facebook ? null : recipient,
          recipientExternalId: facebook ? recipient : null,
          providerAccountId: facebook
            ? this.messengerConfig!.pageId
            : this.config.phoneId,
          outbox: { create: {} },
        },
        select: messageSelect,
      });
    };
    return transaction
      ? enqueue(transaction)
      : this.transactions.run(enqueue, true);
  }
  private async windowOpen(
    tx: Prisma.TransactionClient,
    conversationId: string,
    recipientPhone: string,
    channel: 'WHATSAPP' | 'FACEBOOK' = 'WHATSAPP',
  ) {
    const latest = await tx.message.findFirst({
      where: {
        conversationId,
        ...(channel === 'FACEBOOK'
          ? { recipientExternalId: recipientPhone }
          : { recipientPhone }),
        providerAccountId:
          channel === 'FACEBOOK'
            ? this.messengerConfig!.pageId
            : this.config.phoneId,
        direction: 'INBOUND',
        channel,
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
    if (!this.config.enabled && !this.messengerConfig?.enabled) return 'busy';
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
      const facebook = message.channel === 'FACEBOOK';
      if (facebook ? !this.messengerConfig?.enabled : !this.config.enabled)
        return 'busy' as const;
      const prefix = facebook ? 'MESSENGER' : 'WHATSAPP';
      const recipient = facebook
        ? message.recipientExternalId
        : message.recipientPhone;
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
      if (
        message.processingAttempts >= MESSAGE_ATTEMPTS ||
        !['WHATSAPP', 'FACEBOOK'].includes(message.channel) ||
        message.type !== 'TEXT' ||
        !message.content ||
        !recipient ||
        (facebook &&
          (!this.messengerAdapter || message.content.length > 2000)) ||
        message.providerAccountId !==
          (facebook ? this.messengerConfig!.pageId : this.config.phoneId)
      ) {
        await this.finish(tx, messageId, 'FAILED', `${prefix}_SEND_INVALID`);
        return 'terminal' as const;
      }
      if (
        !(await this.windowOpen(
          tx,
          message.conversationId,
          recipient,
          facebook ? 'FACEBOOK' : 'WHATSAPP',
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
    const facebook = claimed.channel === 'FACEBOOK';
    const prefix = facebook ? 'MESSENGER' : 'WHATSAPP';
    // Never include the external POST inside a retried database transaction.
    let externalMessageId: string | undefined;
    let failure: WhatsAppSendError | undefined;
    try {
      externalMessageId = await (
        facebook ? this.messengerAdapter! : this.adapter
      ).sendMessage(
        (facebook ? claimed.recipientExternalId : claimed.recipientPhone)!,
        claimed.content!,
      );
    } catch (error) {
      failure =
        error instanceof WhatsAppSendError
          ? error
          : new WhatsAppSendError('unknown');
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
