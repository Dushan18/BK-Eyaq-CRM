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
import type { ContactChannel } from '../../generated/prisma/enums';
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
  exceedsTextLimit,
  isRetryableSendError,
  type ChannelAddress,
  type ChannelTransport,
  type OutboundTemplate,
} from './channel-transport';
import { AssistantBridge } from './assistant-bridge';

// Meta's customer service window, shared by WhatsApp and Messenger.
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
// A template still queued after this (outbox or channel down) is about something that
// already happened: it fails instead of reaching the customer late.
export const TEMPLATE_TTL_MS = 6 * 60 * 60 * 1000;
const hasAddress = (address: ChannelAddress) =>
  !!address.recipientPhone || !!address.recipientExternalId;
@Injectable()
export class OutboundMessagesService {
  private readonly logger = new Logger(OutboundMessagesService.name);
  constructor(
    private readonly transactions: MessagingTransactionService,
    private readonly transports: ChannelTransports,
    @Optional() private readonly assistant?: AssistantBridge,
  ) {}
  // `operatorReply`: a person typed the message, so automatic Samanta steps aside.
  async queueOutboundMessage(
    conversationId: string,
    authorUserId: string,
    key: string | undefined,
    dto: OutboundMessageDto,
    transaction?: Prisma.TransactionClient,
    options: { operatorReply?: boolean } = {},
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
      const { conversation, transport, recipient } = await this.replyTarget(
        tx,
        conversationId,
        dto.content,
      );
      const takeOver =
        options.operatorReply &&
        this.assistant?.handler?.autoReplies &&
        !conversation.isAssistantPaused;
      const current = await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastSequence: { increment: 1 },
          lastMessageAt: new Date(),
          ...(takeOver
            ? {
                isAssistantPaused: true,
                assistantPauseReason: 'OPERATOR_REPLIED' as const,
                assistantPausedAt: new Date(),
              }
            : {}),
        },
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
          recipientPhone: recipient.recipientPhone,
          recipientExternalId: recipient.recipientExternalId,
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
  // Whether a template could be queued on this channel right now.
  canSendTemplates(channel: ContactChannel) {
    const transport = this.transports.find(channel);
    return !!transport?.sendTemplate && transport.enabled;
  }
  // Business-initiated template (WhatsApp): the one message allowed with the 24-hour window
  // closed, so there is no window check. It goes to the phone the customer gave us; `content`
  // is the CRM's rendering of the template for the history.
  async queueTemplateMessage(
    conversationId: string,
    authorUserId: string,
    key: string,
    template: OutboundTemplate & { content: string },
    transaction?: Prisma.TransactionClient,
  ) {
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(key))
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
        select: { ...messageSelect, templateParameters: true },
      });
      if (existing) {
        const { templateParameters, ...message } = existing;
        if (
          existing.authorUserId !== authorUserId ||
          existing.templateName !== template.name ||
          templateParameters.join('\u0000') !==
            template.parameters.join('\u0000')
        )
          throw new ConflictException(
            'Idempotency-Key ya utilizada con otros datos',
          );
        return message;
      }
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        include: {
          customer: {
            select: {
              normalizedPhone: true,
              providerAccountId: true,
              externalContactId: true,
              whatsappUserId: true,
            },
          },
        },
      });
      if (!conversation)
        throw new NotFoundException('Conversación no encontrada');
      const transport = this.transports.find(conversation.channel);
      if (!transport?.sendTemplate)
        throw new BadRequestException('El canal no admite plantillas');
      transport.assertEnabled();
      const candidates = transport.recipientOf(conversation.customer);
      const recipient: ChannelAddress | null = candidates?.recipientPhone
        ? {
            recipientPhone: candidates.recipientPhone,
            recipientExternalId: null,
          }
        : candidates?.recipientExternalId
          ? {
              recipientPhone: null,
              recipientExternalId: candidates.recipientExternalId,
            }
          : null;
      if (!recipient)
        throw new BadRequestException(
          'Conversación sin destinatario habilitado',
        );
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
          type: 'TEXT',
          content: template.content,
          templateName: template.name,
          templateLanguage: template.language,
          templateParameters: template.parameters,
          authorUserId,
          idempotencyKey: key,
          recipientPhone: recipient.recipientPhone,
          recipientExternalId: recipient.recipientExternalId,
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
  // Same checks as sending, without sending: lets Samanta skip a paid generation
  // that could never be delivered (channel off, no recipient or window closed).
  // Returns how many characters a reply may have; channels limited in bytes get a
  // margin because accented letters and emojis take more than one byte.
  async assertCanReply(tx: Prisma.TransactionClient, conversationId: string) {
    const { transport } = await this.replyTarget(tx, conversationId);
    return transport.maxTextBytes === undefined
      ? transport.maxTextLength
      : Math.min(
          transport.maxTextLength,
          Math.floor(transport.maxTextBytes * 0.8),
        );
  }
  private async replyTarget(
    tx: Prisma.TransactionClient,
    conversationId: string,
    content?: string,
  ) {
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      include: {
        customer: {
          select: {
            normalizedPhone: true,
            providerAccountId: true,
            externalContactId: true,
            whatsappUserId: true,
          },
        },
      },
    });
    if (!conversation)
      throw new NotFoundException('Conversación no encontrada');
    const transport = this.transports.find(conversation.channel);
    if (!transport)
      throw new BadRequestException('Conversación sin destinatario habilitado');
    transport.assertEnabled();
    if (content !== undefined && content.length > transport.maxTextLength)
      throw new BadRequestException(
        `${transport.label} admite hasta ${transport.maxTextLength} caracteres por respuesta`,
      );
    if (content !== undefined && exceedsTextLimit(transport, content))
      throw new BadRequestException(
        `${transport.label} admite hasta ${transport.maxTextBytes} bytes por respuesta; las tildes y los emojis ocupan más de uno`,
      );
    const candidates = transport.recipientOf(conversation.customer);
    if (!candidates || !hasAddress(candidates))
      throw new BadRequestException('Conversación sin destinatario habilitado');
    const recipient = await this.openAddress(
      tx,
      conversationId,
      transport,
      candidates,
    );
    if (!recipient) throw new ConflictException(transport.windowClosedMessage);
    return { conversation, transport, recipient };
  }
  // The first candidate, phone first, with an inbound message inside the window.
  private async openAddress(
    tx: Prisma.TransactionClient,
    conversationId: string,
    transport: ChannelTransport,
    candidates: ChannelAddress,
  ): Promise<ChannelAddress | null> {
    const options: ChannelAddress[] = [
      ...(candidates.recipientPhone
        ? [
            {
              recipientPhone: candidates.recipientPhone,
              recipientExternalId: null,
            },
          ]
        : []),
      ...(candidates.recipientExternalId
        ? [
            {
              recipientPhone: null,
              recipientExternalId: candidates.recipientExternalId,
            },
          ]
        : []),
    ];
    for (const option of options)
      if (await this.windowOpen(tx, conversationId, transport, option))
        return option;
    return null;
  }
  private async windowOpen(
    tx: Prisma.TransactionClient,
    conversationId: string,
    transport: ChannelTransport,
    recipient: ChannelAddress,
  ) {
    const latest = await tx.message.findFirst({
      where: {
        conversationId,
        OR: [
          ...(recipient.recipientPhone
            ? [{ recipientPhone: recipient.recipientPhone }]
            : []),
          ...(recipient.recipientExternalId
            ? [{ recipientExternalId: recipient.recipientExternalId }]
            : []),
        ],
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
      const recipient: ChannelAddress = {
        recipientPhone: message.recipientPhone,
        recipientExternalId: message.recipientExternalId,
      };
      const isTemplate = message.templateName !== null;
      if (
        !transport ||
        message.processingAttempts >= MESSAGE_ATTEMPTS ||
        message.type !== 'TEXT' ||
        !message.content ||
        !hasAddress(recipient) ||
        exceedsTextLimit(transport, message.content) ||
        message.providerAccountId !== transport.providerAccountId ||
        (isTemplate && (!transport.sendTemplate || !message.templateLanguage))
      ) {
        await this.finish(tx, messageId, 'FAILED', `${prefix}_SEND_INVALID`);
        return 'terminal' as const;
      }
      if (
        isTemplate &&
        message.createdAt.getTime() < Date.now() - TEMPLATE_TTL_MS
      ) {
        await this.finish(
          tx,
          messageId,
          'FAILED',
          `${prefix}_TEMPLATE_EXPIRED`,
        );
        return 'terminal' as const;
      }
      // A template is exactly what Meta allows with the window closed.
      if (
        !isTemplate &&
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
    const address: ChannelAddress = {
      recipientPhone: claimed.recipientPhone,
      recipientExternalId: claimed.recipientExternalId,
    };
    try {
      externalMessageId =
        claimed.templateName !== null && transport.sendTemplate
          ? await transport.sendTemplate(address, {
              name: claimed.templateName,
              language: claimed.templateLanguage!,
              parameters: claimed.templateParameters,
            })
          : await transport.sendMessage(address, claimed.content!);
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
