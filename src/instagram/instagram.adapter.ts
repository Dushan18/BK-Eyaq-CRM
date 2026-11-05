import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InstagramConfig } from './instagram.config';
import type { MessagingChannelAdapter } from '../messaging/channel-adapter';
import {
  validateInboundMessage,
  type InboundMessageCommand,
} from '../messaging/inbound-message.command';
import {
  ChannelSendError,
  type ChannelAddress,
  type ChannelRecipientSource,
  type ChannelTransport,
} from '../messaging/channel-transport';
import { readSendDiagnostic } from '../messaging/send-diagnostic';
import { fingerprint } from '../messaging/meta-webhook';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Evento Instagram inválido');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new BadRequestException('Evento Instagram inválido');
  return value;
}

@Injectable()
export class InstagramAdapter
  implements MessagingChannelAdapter, ChannelTransport
{
  readonly channel = 'INSTAGRAM' as const;
  readonly errorPrefix = 'INSTAGRAM';
  readonly label = 'Instagram';
  // Meta: "UTF-8 and 1,000 bytes or less"; accents and emojis take more than one byte.
  readonly maxTextLength = 1000;
  readonly maxTextBytes = 1000;
  readonly windowClosedMessage =
    'Ventana de Instagram cerrada; el cliente debe enviar un nuevo mensaje';
  private readonly logger = new Logger(InstagramAdapter.name);
  constructor(private readonly config: InstagramConfig) {}
  // Instagram receives without a token, but replies need one.
  get enabled() {
    return this.config.canSend;
  }
  get providerAccountId() {
    return this.config.accountId;
  }
  assertEnabled() {
    this.config.assertCanSend();
  }
  // An IGSID only exists for one Instagram account.
  recipientOf(customer: ChannelRecipientSource): ChannelAddress | null {
    return customer.providerAccountId === this.config.accountId &&
      customer.externalContactId
      ? {
          recipientPhone: null,
          recipientExternalId: customer.externalContactId,
        }
      : null;
  }
  // Instagram API with Facebook Login: the account's /messages edge accepts the system-user
  // token with instagram_manage_messages (the Page edge would need a Page token).
  async sendMessage(address: ChannelAddress, content: string): Promise<string> {
    this.config.assertCanSend();
    const to = address.recipientExternalId;
    if (
      !to ||
      !/^\d{1,80}$/.test(to) ||
      !content.trim() ||
      Buffer.byteLength(content, 'utf8') > this.maxTextBytes
    )
      throw new ChannelSendError('failed');
    let response: Response;
    try {
      response = await fetch(
        `https://graph.facebook.com/${this.config.version}/${this.config.accountId}/messages`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: { id: to },
            message: { text: content },
          }),
        },
      );
    } catch {
      throw new ChannelSendError('unknown');
    }
    // Shared outcome contract with the durable outbox; never blindly resend uncertain POSTs.
    const diagnostic = response.ok
      ? undefined
      : await readSendDiagnostic(response);
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? '1');
      throw new ChannelSendError(
        'retry',
        Number.isFinite(seconds)
          ? Math.min(3600000, Math.max(1000, seconds * 1000))
          : 1000,
        diagnostic,
      );
    }
    if (response.status >= 500 || response.status === 408)
      throw new ChannelSendError('unknown', 1000, diagnostic);
    if (!response.ok) throw new ChannelSendError('failed', 1000, diagnostic);
    try {
      const result = object(await response.json());
      if (result.recipient_id !== to || typeof result.message_id !== 'string')
        throw new Error('Unexpected response');
      return result.message_id;
    } catch {
      throw new ChannelSendError('unknown');
    }
  }
  parseInboundEvent(event: unknown): Promise<InboundMessageCommand[]> {
    return Promise.resolve(this.parse(event).messages);
  }
  parse(event: unknown) {
    const messages: InboundMessageCommand[] = [];
    const rejected: string[] = [];
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
      if (root.object !== 'instagram') return;
      for (const rawEntry of list(root.entry))
        guard(rawEntry, () => {
          const entry = object(rawEntry);
          if (entry.id !== this.config.accountId) return;
          for (const raw of list(entry.messaging))
            guard(raw, () => {
              const item = object(raw);
              // Receipts, postbacks, reactions and echoes must not create conversations.
              if (item.message === undefined) return;
              const message = object(item.message);
              if (
                message.is_echo ||
                message.is_deleted ||
                message.is_unsupported
              )
                return;
              if (object(item.recipient).id !== this.config.accountId) return;
              const sender = object(item.sender).id;
              if (sender === this.config.accountId) return;
              const timestamp = item.timestamp;
              if (
                typeof timestamp !== 'number' ||
                !Number.isSafeInteger(timestamp) ||
                timestamp <= 0 ||
                timestamp > Date.now() + 60000
              )
                throw new BadRequestException('Fecha Instagram inválida');
              if (
                message.text === undefined &&
                !list(message.attachments).length
              )
                throw new BadRequestException('Mensaje Instagram vacío');
              messages.push(
                validateInboundMessage({
                  channel: this.channel,
                  providerAccountId: this.config.accountId,
                  externalMessageId: message.mid,
                  contact: { externalId: sender },
                  occurredAt: new Date(timestamp).toISOString(),
                  type: message.text === undefined ? 'OTHER' : 'TEXT',
                  content:
                    message.text === undefined
                      ? '[Adjunto de Instagram no compatible todavía]'
                      : message.text,
                }),
              );
            });
        });
    });
    return { messages, rejected };
  }
  // The webhook only carries the IGSID; the User Profile API gives the profile name (optional
  // on Instagram) and the username, which keeps customers without a name recognizable.
  // Best effort, as in Messenger: any failure or mismatch means "unknown", never an error,
  // and failures are logged without the IGSID or the name.
  async fetchSenderName(senderId: string): Promise<string | null> {
    if (!this.config.enabled || !this.config.accessToken) return null;
    const failed = (detail: Record<string, string | number>) => {
      this.logger.warn(
        JSON.stringify({ code: 'INSTAGRAM_NAME_LOOKUP_FAILED', ...detail }),
      );
      return null;
    };
    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.config.version}/${encodeURIComponent(senderId)}?fields=name,username`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(2000),
          headers: { Authorization: `Bearer ${this.config.accessToken}` },
        },
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return failed({ status: response.status });
      }
      const profile = object(await response.json());
      if (profile.id !== senderId) return failed({ reason: 'SENDER_MISMATCH' });
      const clean = (value: unknown) =>
        typeof value === 'string' ? value.trim().slice(0, 100).trim() : '';
      const name = clean(profile.name);
      if (name && !/^(instagram user|usuario de instagram)$/i.test(name))
        return name;
      const username = clean(profile.username);
      return /^[\w.]{1,30}$/.test(username) ? `@${username}` : null;
    } catch (error) {
      return failed({
        reason: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}
