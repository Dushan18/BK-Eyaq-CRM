import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InstagramConfig } from './instagram.config';
import type { MessagingChannelAdapter } from '../messaging/channel-adapter';
import {
  validateInboundMessage,
  type InboundMessageCommand,
} from '../messaging/inbound-message.command';
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
export class InstagramAdapter implements MessagingChannelAdapter {
  readonly channel = 'INSTAGRAM' as const;
  private readonly logger = new Logger(InstagramAdapter.name);
  constructor(private readonly config: InstagramConfig) {}
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
