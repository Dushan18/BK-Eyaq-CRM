import { ConflictException, Injectable } from '@nestjs/common';
import { normalizeContact } from '../common/contact-normalization';
import { CustomersService } from '../customers/customers.service';
import { MessagingTransactionService } from './messaging-transaction.service';
import { validateInboundMessage } from './inbound-message.command';
import { messageSelect } from './messaging.select';

@Injectable()
export class MessagesService {
  constructor(
    private readonly customers: CustomersService,
    private readonly transactions: MessagingTransactionService,
  ) {}

  async ingestInboundMessage(input: unknown) {
    const command = validateInboundMessage(input);
    const contact = normalizeContact(command.contact);
    return this.transactions.run(async (tx) => {
      const existing = await tx.message.findUnique({
        where: {
          channel_externalMessageId: {
            channel: command.channel,
            externalMessageId: command.externalMessageId,
          },
        },
        select: {
          ...messageSelect,
          conversation: {
            select: {
              customer: {
                select: { normalizedPhone: true, normalizedEmail: true },
              },
            },
          },
        },
      });
      if (existing) {
        const identity = existing.conversation.customer;
        const matches =
          (contact.normalizedPhone &&
            contact.normalizedPhone === identity.normalizedPhone) ||
          (contact.normalizedEmail &&
            contact.normalizedEmail === identity.normalizedEmail);
        const conflicts =
          (contact.normalizedPhone &&
            identity.normalizedPhone &&
            contact.normalizedPhone !== identity.normalizedPhone) ||
          (contact.normalizedEmail &&
            identity.normalizedEmail &&
            contact.normalizedEmail !== identity.normalizedEmail);
        if (!matches || conflicts)
          throw new ConflictException(
            'El identificador del mensaje pertenece a otra identidad',
          );
        const { conversation: _private, ...message } = existing;
        void _private;
        return { message, duplicate: true };
      }
      const customer = await this.customers.findOrCreateByContact(
        { ...command.contact, sourceChannel: command.channel },
        tx,
      );
      const conversation = await tx.conversation.upsert({
        where: {
          customerId_channel: {
            customerId: customer.id,
            channel: command.channel,
          },
        },
        create: {
          customerId: customer.id,
          channel: command.channel,
          externalConversationId: command.externalConversationId,
        },
        update: {},
      });
      // Increment serializes ingestion and makes the read cutoff independent of clocks.
      const current = await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastSequence: { increment: 1 } },
      });
      const receivedAt = new Date();
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt:
            current.lastMessageAt && current.lastMessageAt > receivedAt
              ? current.lastMessageAt
              : receivedAt,
        },
      });
      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          channel: command.channel,
          sequence: current.lastSequence,
          externalMessageId: command.externalMessageId,
          direction: 'INBOUND',
          providerAccountId: command.providerAccountId,
          recipientPhone: contact.normalizedPhone,
          status: 'RECEIVED',
          type: command.type,
          content: command.content,
          receivedAt,
          occurredAt: command.occurredAt ? new Date(command.occurredAt) : null,
          attachments: { create: command.attachments },
          outbox: { create: {} },
        },
        select: messageSelect,
      });
      // TODO: MESSAGE_RECEIVED audit event; never log content/contact.
      return { message, duplicate: false };
    }, true);
  }
}
