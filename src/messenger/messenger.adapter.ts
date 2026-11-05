import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MessengerConfig } from './messenger.config';
import type { MessagingChannelAdapter } from '../messaging/channel-adapter';
import {
  validateInboundMessage,
  type InboundMessageCommand,
} from '../messaging/inbound-message.command';
import {
  ChannelSendError,
  type ChannelDeliveryStatus,
  type ChannelRecipientSource,
  type ChannelTransport,
} from '../messaging/channel-transport';
import { readSendDiagnostic } from '../messaging/send-diagnostic';
import { fingerprint } from '../messaging/meta-webhook';

export interface MessengerDeliveryWatermark {
  recipientId: string;
  watermark: Date;
  occurredAt: Date;
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Evento Messenger inválido');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new BadRequestException('Evento Messenger inválido');
  return value;
}
function text(value: unknown, max = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BadRequestException('Evento Messenger inválido');
  return value;
}
function id(value: unknown) {
  const result = text(value, 80);
  if (!/^\d+$/.test(result))
    throw new BadRequestException('ID Messenger inválido');
  return result;
}
function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= Date.now() + 60000
  );
}
function date(value: unknown): Date {
  if (!isTimestamp(value))
    throw new BadRequestException('Fecha Messenger inválida');
  return new Date(value);
}

@Injectable()
export class MessengerAdapter
  implements MessagingChannelAdapter, ChannelTransport
{
  readonly channel = 'FACEBOOK' as const;
  readonly errorPrefix = 'MESSENGER';
  readonly label = 'Messenger';
  readonly maxTextLength = 2000;
  readonly windowClosedMessage =
    'Ventana de Messenger cerrada; el cliente debe enviar un nuevo mensaje';
  readonly recipientField = 'recipientExternalId' as const;
  private readonly logger = new Logger(MessengerAdapter.name);
  constructor(private readonly config: MessengerConfig) {}
  get enabled() {
    return this.config.enabled;
  }
  get providerAccountId() {
    return this.config.pageId;
  }
  assertEnabled() {
    this.config.assertEnabled();
  }
  // A PSID only exists for one Page: a customer of another Page is not addressable here.
  recipientOf(customer: ChannelRecipientSource) {
    return customer.providerAccountId === this.config.pageId
      ? customer.externalContactId
      : null;
  }
  parseInboundEvent(event: unknown): Promise<InboundMessageCommand[]> {
    return Promise.resolve(this.parse(event).messages);
  }
  parse(event: unknown) {
    const messages: InboundMessageCommand[] = [];
    const statuses: ChannelDeliveryStatus[] = [];
    const watermarks: MessengerDeliveryWatermark[] = [];
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
      const root = obj(event);
      if (root.object !== 'page') return;
      for (const rawEntry of list(root.entry))
        guard(rawEntry, () => {
          const entry = obj(rawEntry);
          if (entry.id !== this.config.pageId) return;
          for (const raw of list(entry.messaging))
            guard(raw, () => {
              const item = obj(raw);
              if (obj(item.recipient).id !== this.config.pageId) return;
              const senderId = id(obj(item.sender).id);
              if (senderId === this.config.pageId) return;
              if (item.message !== undefined) {
                const message = obj(item.message);
                // Echoes/deletions do not create customers or reopen response windows.
                if (
                  message.is_echo ||
                  message.is_deleted ||
                  message.is_unsupported
                )
                  return;
                messages.push(
                  validateInboundMessage({
                    channel: this.channel,
                    providerAccountId: this.config.pageId,
                    externalMessageId: text(message.mid),
                    contact: { externalId: senderId },
                    occurredAt: date(item.timestamp).toISOString(),
                    type: message.text === undefined ? 'OTHER' : 'TEXT',
                    content:
                      message.text === undefined
                        ? '[Adjunto de Messenger no compatible todavía]'
                        : text(message.text, 16000),
                  }),
                );
              } else if (item.delivery !== undefined) {
                const delivery = obj(item.delivery);
                // Validate the whole receipt first: it is either recorded or quarantined.
                const watermark =
                  delivery.watermark == null
                    ? undefined
                    : date(delivery.watermark);
                // The watermark marks send times ("sent at or before were delivered"), not
                // the delivery itself. It only stands in for a missing or implausible event
                // time: a receipt cannot predate the sends it confirms.
                const occurredAt =
                  isTimestamp(item.timestamp) &&
                  (!watermark || item.timestamp >= watermark.getTime())
                    ? new Date(item.timestamp)
                    : (watermark ?? date(item.timestamp));
                const mids = list(delivery.mids).map((mid) => text(mid));
                for (const mid of mids)
                  statuses.push({
                    externalMessageId: mid,
                    providerAccountId: this.config.pageId,
                    status: 'DELIVERED',
                    occurredAt,
                  });
                // mids is optional; the watermark alone still confirms earlier replies.
                if (watermark)
                  watermarks.push({
                    recipientId: senderId,
                    watermark,
                    occurredAt,
                  });
              }
              // Read watermarks and postbacks are deliberately unsupported in v1.
            });
        });
    });
    return { messages, statuses, watermarks, rejected };
  }
  // The webhook only carries the PSID. The sender of one of our received messages is the
  // name source that works for this Page without App Review (the User Profile API needs it).
  // Best effort: any failure, mismatch or placeholder name means "unknown", never an error.
  // Failures are logged without the PSID or the name: a missing permission would otherwise
  // cost one silent Graph call per message from every customer still without a name.
  async fetchSenderName(
    messageId: string,
    senderId: string,
  ): Promise<string | null> {
    if (!this.config.enabled) return null;
    const failed = (detail: Record<string, string | number>) => {
      this.logger.warn(
        JSON.stringify({ code: 'MESSENGER_NAME_LOOKUP_FAILED', ...detail }),
      );
      return null;
    };
    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.config.version}/${encodeURIComponent(messageId)}?fields=from`,
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
      const from = obj(obj(await response.json()).from);
      if (from.id !== senderId || typeof from.name !== 'string')
        return failed({ reason: 'SENDER_MISMATCH' });
      const name = from.name.trim().slice(0, 100).trim();
      return name && !/^(facebook user|usuario de facebook)$/i.test(name)
        ? name
        : null;
    } catch (error) {
      return failed({
        reason: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
  async sendMessage(to: string, content: string): Promise<string> {
    this.config.assertEnabled();
    id(to);
    text(content, this.maxTextLength);
    let response: Response;
    try {
      response = await fetch(
        `https://graph.facebook.com/${this.config.version}/${this.config.pageId}/messages`,
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
            messaging_type: 'RESPONSE',
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
      const result = obj(await response.json());
      if (result.recipient_id !== to) throw new Error('Recipient mismatch');
      return text(result.message_id);
    } catch {
      throw new ChannelSendError('unknown');
    }
  }
}
