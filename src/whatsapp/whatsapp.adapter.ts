import { BadRequestException, Injectable } from '@nestjs/common';
import type { MessagingChannelAdapter } from '../messaging/channel-adapter';
import {
  validateInboundMessage,
  WHATSAPP_USER_ID,
  WHATSAPP_USERNAME,
  type InboundMessageCommand,
} from '../messaging/inbound-message.command';
import {
  ChannelSendError,
  type ChannelAddress,
  type ChannelDeliveryStatus,
  type ChannelRecipientSource,
  type ChannelTransport,
  type OutboundTemplate,
} from '../messaging/channel-transport';
import { readSendDiagnostic } from '../messaging/send-diagnostic';
import { fingerprint } from '../messaging/meta-webhook';
import { WhatsAppConfig } from './whatsapp.config';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Evento WhatsApp inválido');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new BadRequestException('Evento WhatsApp inválido');
  return value;
}
function text(value: unknown, max = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BadRequestException('Evento WhatsApp inválido');
  return value;
}
function optionalText(value: unknown, max: number) {
  return value === undefined ? undefined : text(value, max);
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
interface WhatsAppProfile {
  /** Username without "@", only if the user adopted one. */
  username?: string;
  /** Profile name the person chose (often a nickname). */
  name?: string;
}
// What a webhook contact says about its sender. Lenient: a malformed contact only means
// "unknown", it never rejects the message.
function contactProfile(
  contact: Record<string, unknown> | null,
): WhatsAppProfile | undefined {
  const profile = record(contact?.profile);
  if (!profile) return undefined;
  const username =
    typeof profile.username === 'string'
      ? profile.username.trim().replace(/^@/, '')
      : '';
  const name =
    typeof profile.name === 'string'
      ? profile.name.trim().slice(0, 100).trim()
      : '';
  return {
    ...(WHATSAPP_USERNAME.test(username) ? { username } : {}),
    ...(name ? { name } : {}),
  };
}
// What the customer chose with a tap: a template's quick-reply button arrives as type
// "button" (button.text); our own interactive buttons and list rows as type "interactive"
// (button_reply / list_reply, with the visible title). Lenient: anything else is unknown.
function chosenReply(message: Record<string, unknown>): string | undefined {
  const interactive = record(message.interactive);
  const value =
    message.type === 'button'
      ? record(message.button)?.text
      : message.type === 'interactive'
        ? (record(interactive?.button_reply) ?? record(interactive?.list_reply))
            ?.title
        : undefined;
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 1000)
    : undefined;
}
// Meta issues a new BSUID when a user changes their number and reports the previous one.
export interface WhatsAppUserIdChange {
  previous: string;
  current: string;
}
function timestamp(value: unknown): Date {
  const seconds = text(value, 12);
  if (!/^\d+$/.test(seconds))
    throw new BadRequestException('Fecha WhatsApp inválida');
  const date = new Date(Number(seconds) * 1000);
  // Future/replayed events must not open an artificial service window.
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 60000)
    throw new BadRequestException('Fecha WhatsApp inválida');
  return date;
}

@Injectable()
export class WhatsAppAdapter
  implements MessagingChannelAdapter, ChannelTransport
{
  readonly channel = 'WHATSAPP' as const;
  readonly errorPrefix = 'WHATSAPP';
  readonly label = 'WhatsApp';
  readonly maxTextLength = 4096;
  readonly windowClosedMessage =
    'Ventana de WhatsApp cerrada; se requiere una plantilla aprobada';
  constructor(private readonly config: WhatsAppConfig) {}
  get enabled() {
    return this.config.enabled;
  }
  get providerAccountId() {
    return this.config.phoneId;
  }
  assertEnabled() {
    this.config.assertEnabled();
  }
  // Both are candidates: the reply goes to the one the customer wrote from in the last 24
  // hours, phone first (see ChannelAddress).
  recipientOf(customer: ChannelRecipientSource): ChannelAddress | null {
    return customer.normalizedPhone || customer.whatsappUserId
      ? {
          recipientPhone: customer.normalizedPhone,
          recipientExternalId: customer.whatsappUserId,
        }
      : null;
  }
  parseInboundEvent(event: unknown): Promise<InboundMessageCommand[]> {
    return Promise.resolve(this.parse(event).messages);
  }
  parse(event: unknown) {
    const messages: InboundMessageCommand[] = [];
    const statuses: ChannelDeliveryStatus[] = [];
    const rejected: string[] = [];
    const userIdChanges: WhatsAppUserIdChange[] = [];
    const guard = (raw: unknown, operation: () => void) => {
      try {
        operation();
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        rejected.push(fingerprint(raw));
      }
    };
    guard(event, () => {
      const root = object(event);
      if (root.object !== 'whatsapp_business_account') return;
      for (const rawEntry of list(root.entry))
        guard(rawEntry, () => {
          const entry = object(rawEntry);
          if (entry.id !== this.config.businessId) return;
          for (const rawChange of list(entry.changes))
            guard(rawChange, () => {
              const change = object(rawChange);
              if (change.field !== 'messages') return;
              const value = object(change.value);
              if (
                object(value.metadata).phone_number_id !== this.config.phoneId
              )
                return;
              // Senders described in value.contacts, by BSUID (user_id) and by phone (wa_id).
              const senders = new Map<string, WhatsAppProfile>();
              const contacts: unknown[] = Array.isArray(value.contacts)
                ? value.contacts
                : [];
              for (const raw of contacts) {
                const contact = record(raw);
                const profile = contactProfile(contact);
                if (!profile) continue;
                if (typeof contact?.user_id === 'string')
                  senders.set(`user:${contact.user_id}`, profile);
                if (typeof contact?.wa_id === 'string')
                  senders.set(`phone:${contact.wa_id}`, profile);
              }
              for (const raw of list(value.messages))
                guard(raw, () => {
                  const message = object(raw);
                  // Meta omits `from` (the phone) for some users with a username, but always
                  // sends their business-scoped user ID in `from_user_id`.
                  const from = optionalText(message.from, 15);
                  if (from !== undefined && !/^[1-9]\d{6,14}$/.test(from))
                    throw new BadRequestException();
                  const userId = optionalText(message.from_user_id, 160);
                  if (userId !== undefined && !WHATSAPP_USER_ID.test(userId))
                    throw new BadRequestException();
                  if (from === undefined && userId === undefined)
                    throw new BadRequestException();
                  if (message.type === 'system') {
                    const system = record(message.system);
                    if (system?.type === 'user_changed_user_id') {
                      const previous = text(system.previous_user_id, 160);
                      if (!userId || !WHATSAPP_USER_ID.test(previous))
                        throw new BadRequestException();
                      userIdChanges.push({ previous, current: userId });
                      return;
                    }
                  }
                  const profile =
                    (userId && senders.get(`user:${userId}`)) ||
                    (from && senders.get(`phone:${from}`)) ||
                    undefined;
                  const base = {
                    channel: this.channel,
                    providerAccountId: this.config.phoneId,
                    externalMessageId: text(message.id),
                    contact: {
                      ...(from ? { phone: `+${from}` } : {}),
                      ...(userId ? { whatsappUserId: userId } : {}),
                      ...(profile?.username
                        ? { whatsappUsername: profile.username }
                        : {}),
                      ...(profile?.name
                        ? { whatsappProfileName: profile.name }
                        : {}),
                    },
                    occurredAt: timestamp(message.timestamp).toISOString(),
                    // The message this one quotes or answers with a button (our wamid).
                    ...(optionalText(record(message.context)?.id, 255)
                      ? {
                          replyToExternalMessageId: optionalText(
                            record(message.context)?.id,
                            255,
                          ),
                        }
                      : {}),
                  };
                  let command: InboundMessageCommand;
                  const reply = chosenReply(message);
                  if (message.type === 'text') {
                    command = {
                      ...base,
                      type: 'TEXT',
                      content: text(object(message.text).body, 16000),
                    };
                  } else if (reply !== undefined) {
                    // A button tap is what the customer "said": Samanta answers it.
                    command = {
                      ...base,
                      type: 'TEXT',
                      content: reply,
                      buttonReply: true,
                    };
                  } else if (
                    message.type === 'image' ||
                    message.type === 'document'
                  ) {
                    const media = object(message[message.type]);
                    const type = message.type === 'image' ? 'IMAGE' : 'FILE';
                    command = {
                      ...base,
                      type,
                      content: optionalText(media.caption, 16000),
                      attachments: [
                        {
                          type,
                          externalMediaId: text(media.id),
                          mimeType: optionalText(media.mime_type, 150),
                          fileName: optionalText(media.filename, 255),
                        },
                      ],
                    };
                  } else {
                    command = {
                      ...base,
                      type: 'OTHER',
                      content: '[Mensaje de WhatsApp no compatible todavía]',
                    };
                  }
                  messages.push(validateInboundMessage(command));
                });
              for (const raw of list(value.statuses))
                guard(raw, () => {
                  const status = object(raw);
                  if (
                    !['sent', 'delivered', 'read', 'failed'].includes(
                      String(status.status),
                    )
                  )
                    return;
                  statuses.push({
                    externalMessageId: text(status.id),
                    providerAccountId: this.config.phoneId,
                    status: String(
                      status.status,
                    ).toUpperCase() as ChannelDeliveryStatus['status'],
                    occurredAt: timestamp(status.timestamp),
                  });
                });
            });
        });
    });
    return { messages, statuses, rejected, userIdChanges };
  }
  sendMessage(address: ChannelAddress, content: string): Promise<string> {
    return this.post(address, { type: 'text', text: { body: content } });
  }
  // Template parameters cannot contain line breaks, tabs or more than four consecutive
  // spaces; Meta rejects the whole message otherwise.
  sendTemplate(address: ChannelAddress, template: OutboundTemplate) {
    return this.post(address, {
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(template.parameters.length
          ? {
              components: [
                {
                  type: 'body',
                  parameters: template.parameters.map((value) => ({
                    type: 'text',
                    text: value.replace(/\s+/g, ' ').trim() || '-',
                  })),
                },
              ],
            }
          : {}),
      },
    });
  }
  private async post(
    address: ChannelAddress,
    message: Record<string, unknown>,
  ): Promise<string> {
    this.config.assertEnabled();
    // Meta addresses a BSUID with `recipient`; with both, it would use `to` anyway.
    const target = address.recipientPhone
      ? { to: address.recipientPhone.replace(/^\+/, '') }
      : address.recipientExternalId
        ? { recipient: address.recipientExternalId }
        : null;
    if (!target) throw new ChannelSendError('failed');
    let response: Response;
    try {
      response = await fetch(
        `https://graph.facebook.com/${this.config.version}/${this.config.phoneId}/messages`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            ...target,
            ...message,
          }),
        },
      );
    } catch {
      throw new ChannelSendError('unknown');
    }
    // Only an explicit rate-limit rejection is automatically retried. Network/5xx
    // may occur after acceptance; never assume provider-side idempotency.
    const diagnostic = response.ok
      ? undefined
      : await readSendDiagnostic(response);
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 1;
      throw new ChannelSendError(
        'retry',
        Math.min(3600000, Math.max(1000, seconds * 1000)),
        diagnostic,
      );
    }
    if (response.status >= 500 || response.status === 408)
      throw new ChannelSendError('unknown', 1000, diagnostic);
    if (!response.ok) throw new ChannelSendError('failed', 1000, diagnostic);
    try {
      const result = object(await response.json());
      return text(object(list(result.messages)[0]).id);
    } catch {
      throw new ChannelSendError('unknown');
    }
  }
}
