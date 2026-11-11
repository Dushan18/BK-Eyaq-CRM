import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { normalizeContact } from '../common/contact-normalization';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../database/prisma.service';
import { MessagingTransactionService } from './messaging-transaction.service';
import {
  validateInboundMessage,
  type InboundMessageCommand,
} from './inbound-message.command';
import { messageSelect } from './messaging.select';
import { fingerprint } from './meta-webhook';

export const INBOUND_IDENTITY_CONFLICT =
  'El identificador del mensaje pertenece a otra identidad';

@Injectable()
export class MessagesService {
  constructor(
    private readonly customers: CustomersService,
    private readonly transactions: MessagingTransactionService,
    private readonly prisma: PrismaService,
  ) {}

  // Single ingestion path for every channel; adapters only translate provider events.
  async ingestInboundMessage(input: unknown) {
    const command = validateInboundMessage(input);
    const {
      externalId,
      whatsappUserId,
      whatsappUsername,
      whatsappProfileName,
      ...contactInput
    } = command.contact;
    const contact = normalizeContact(contactInput, {
      allowMissingContact:
        externalId !== undefined || whatsappUserId !== undefined,
    });
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
          providerAccountId: true,
          recipientExternalId: true,
          conversation: {
            select: {
              customer: {
                select: {
                  normalizedPhone: true,
                  normalizedEmail: true,
                  whatsappUserId: true,
                },
              },
            },
          },
        },
      });
      if (existing) {
        const { conversation, providerAccountId, recipientExternalId } =
          existing;
        const identity = conversation.customer;
        const same =
          externalId !== undefined
            ? existing.direction === 'INBOUND' &&
              providerAccountId === command.providerAccountId &&
              recipientExternalId === externalId
            : (whatsappUserId !== undefined &&
                existing.direction === 'INBOUND' &&
                identity.whatsappUserId === whatsappUserId) ||
              (((contact.normalizedPhone &&
                contact.normalizedPhone === identity.normalizedPhone) ||
                (contact.normalizedEmail &&
                  contact.normalizedEmail === identity.normalizedEmail)) &&
                !(
                  (contact.normalizedPhone &&
                    identity.normalizedPhone &&
                    contact.normalizedPhone !== identity.normalizedPhone) ||
                  (contact.normalizedEmail &&
                    identity.normalizedEmail &&
                    contact.normalizedEmail !== identity.normalizedEmail)
                ));
        if (!same) throw new ConflictException(INBOUND_IDENTITY_CONFLICT);
        const {
          conversation: _conversation,
          providerAccountId: _account,
          recipientExternalId: _recipient,
          ...message
        } = existing;
        void _conversation;
        void _account;
        void _recipient;
        return { message, duplicate: true as const };
      }
      const customer =
        externalId !== undefined
          ? await this.customers.findOrCreateByProviderIdentity(
              {
                sourceChannel: command.channel,
                providerAccountId: command.providerAccountId!,
                externalContactId: externalId,
              },
              tx,
            )
          : whatsappUserId !== undefined ||
              whatsappUsername !== undefined ||
              whatsappProfileName !== undefined
            ? await this.customers.findOrCreateByWhatsApp(
                {
                  phone: contactInput.phone ?? null,
                  userId: whatsappUserId ?? null,
                  // The adapter only sends these when the webhook described the sender.
                  ...(whatsappUsername !== undefined ||
                  whatsappProfileName !== undefined
                    ? {
                        profile: {
                          username: whatsappUsername ?? null,
                          name: whatsappProfileName ?? null,
                        },
                      }
                    : {}),
                },
                tx,
              )
            : await this.customers.findOrCreateByContact(
                { ...contactInput, sourceChannel: command.channel },
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
          recipientExternalId: externalId ?? whatsappUserId ?? null,
          status: 'RECEIVED',
          type: command.type,
          content: command.content,
          receivedAt,
          occurredAt: command.occurredAt ? new Date(command.occurredAt) : null,
          replyToExternalMessageId: command.replyToExternalMessageId ?? null,
          isButtonReply: command.buttonReply === true,
          attachments: { create: command.attachments },
          outbox: { create: {} },
        },
        select: messageSelect,
      });
      // TODO: MESSAGE_RECEIVED audit event; never log content/contact.
      return { message, duplicate: false as const, customer };
    }, true);
  }

  // Webhook policy shared by every provider: invalid or identity-conflicting commands are
  // fingerprinted into `rejected` for quarantine; anything else is rethrown so the provider
  // retries the delivery. Returns the messages that were stored for the first time.
  async ingestFromProvider(
    commands: InboundMessageCommand[],
    rejected: string[],
  ) {
    const created: {
      command: InboundMessageCommand;
      customer: {
        id: string;
        firstName: string | null;
        lastName: string | null;
      };
    }[] = [];
    for (const command of commands) {
      try {
        const result = await this.ingestInboundMessage(command);
        if (!result.duplicate)
          created.push({ command, customer: result.customer });
      } catch (error) {
        // Transient transaction contention must cause provider retry, not quarantine.
        if (
          !(error instanceof BadRequestException) &&
          !(
            error instanceof ConflictException &&
            error.message === INBOUND_IDENTITY_CONFLICT
          )
        )
          throw error;
        rejected.push(fingerprint(command));
      }
    }
    return created;
  }

  async quarantine(fingerprints: string[], code: string) {
    if (!fingerprints.length) return;
    await this.prisma.messagingWebhookRejection.createMany({
      data: fingerprints.map((value) => ({ fingerprint: value, code })),
      skipDuplicates: true,
    });
  }
}
