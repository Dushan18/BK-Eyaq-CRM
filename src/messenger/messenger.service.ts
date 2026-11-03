import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MessengerConfig } from './messenger.config';
import { MessengerAdapter, type MessengerInbound } from './messenger.adapter';
import { MessagingTransactionService } from '../messaging/messaging-transaction.service';
import { MessageStatusService } from '../messaging/message-status.service';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class MessengerService {
  private readonly logger = new Logger(MessengerService.name);
  constructor(
    private readonly config: MessengerConfig,
    private readonly adapter: MessengerAdapter,
    private readonly transactions: MessagingTransactionService,
    private readonly statuses: MessageStatusService,
    private readonly prisma: PrismaService,
  ) {}
  verify(mode: unknown, token: unknown, challenge: unknown) {
    this.config.assertEnabled();
    const expected = Buffer.from(this.config.verifyToken);
    const actual = Buffer.from(typeof token === 'string' ? token : '');
    if (
      mode !== 'subscribe' ||
      typeof challenge !== 'string' ||
      !challenge ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new ForbiddenException('Verificación inválida');
    return challenge;
  }
  async receive(raw: Buffer | undefined, signature: string | undefined) {
    this.config.assertEnabled();
    if (!raw || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
      throw new ForbiddenException('Firma inválida');
    const expected = createHmac('sha256', this.config.appSecret)
      .update(raw)
      .digest();
    if (!timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), expected))
      throw new ForbiddenException('Firma inválida');
    // Parse exactly the bytes authenticated by the signature.
    let event: unknown;
    try {
      event = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      event = null;
    }
    const parsed = this.adapter.parse(event);
    for (const message of parsed.messages) {
      try {
        await this.ingest(message);
      } catch (error) {
        if (
          !(error instanceof ConflictException) ||
          error.message !== 'MESSENGER_IDENTITY_CONFLICT'
        )
          throw error;
        parsed.rejected.push(
          createHash('sha256').update(JSON.stringify(message)).digest('hex'),
        );
      }
    }
    await this.statuses.accept(parsed.statuses, 'FACEBOOK');
    if (parsed.rejected.length) {
      await this.prisma.messagingWebhookRejection.createMany({
        data: parsed.rejected.map((fingerprint) => ({
          fingerprint,
          code: 'MESSENGER_EVENT_INVALID',
        })),
        skipDuplicates: true,
      });
      this.logger.warn(
        JSON.stringify({
          code: 'MESSENGER_EVENT_QUARANTINED',
          count: parsed.rejected.length,
        }),
      );
    }
    return { received: true };
  }
  private async ingest(command: MessengerInbound) {
    return this.transactions.run(async (tx) => {
      const existing = await tx.message.findUnique({
        where: {
          channel_externalMessageId: {
            channel: 'FACEBOOK',
            externalMessageId: command.externalMessageId,
          },
        },
      });
      if (existing) {
        if (
          existing.direction !== 'INBOUND' ||
          existing.providerAccountId !== command.pageId ||
          existing.recipientExternalId !== command.senderId
        )
          throw new ConflictException('MESSENGER_IDENTITY_CONFLICT');
        return;
      }
      const identity = {
        sourceChannel: 'FACEBOOK' as const,
        providerAccountId: command.pageId,
        externalContactId: command.senderId,
      };
      const customer = await tx.customer.upsert({
        where: { sourceChannel_providerAccountId_externalContactId: identity },
        create: identity,
        update: { lastContactAt: new Date() },
      });
      const conversation = await tx.conversation.upsert({
        where: {
          customerId_channel: { customerId: customer.id, channel: 'FACEBOOK' },
        },
        create: { customerId: customer.id, channel: 'FACEBOOK' },
        update: {},
      });
      const current = await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastSequence: { increment: 1 }, lastMessageAt: new Date() },
      });
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          channel: 'FACEBOOK',
          sequence: current.lastSequence,
          externalMessageId: command.externalMessageId,
          providerAccountId: command.pageId,
          recipientExternalId: command.senderId,
          direction: 'INBOUND',
          status: 'RECEIVED',
          type: command.type,
          content: command.content,
          occurredAt: command.occurredAt,
          receivedAt: new Date(),
          outbox: { create: {} },
        },
      });
    }, true);
  }
}
