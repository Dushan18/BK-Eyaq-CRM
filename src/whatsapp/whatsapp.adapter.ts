import { BadRequestException, Injectable } from '@nestjs/common';
import type { MessagingChannelAdapter } from '../messaging/channel-adapter';
import {
  validateInboundMessage,
  type InboundMessageCommand,
} from '../messaging/inbound-message.command';
import { WhatsAppConfig } from './whatsapp.config';
import { createHash } from 'node:crypto';

export interface WhatsAppStatus {
  externalMessageId: string;
  providerAccountId: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  occurredAt: Date;
}
export class WhatsAppSendError extends Error {
  constructor(
    readonly outcome: 'retry' | 'failed' | 'unknown',
    readonly retryAfterMs = 1000,
  ) {
    super(`WHATSAPP_SEND_${outcome.toUpperCase()}`);
  }
}
export function isRetryableWhatsAppError(
  error: unknown,
): error is WhatsAppSendError {
  return error instanceof WhatsAppSendError && error.outcome === 'retry';
}
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
export class WhatsAppAdapter implements MessagingChannelAdapter {
  readonly channel = 'WHATSAPP' as const;
  constructor(private readonly config: WhatsAppConfig) {}
  parseInboundEvent(event: unknown): Promise<InboundMessageCommand[]> {
    return Promise.resolve(this.parse(event).messages);
  }
  parse(event: unknown) {
    const messages: InboundMessageCommand[] = [];
    const statuses: WhatsAppStatus[] = [];
    const rejected: string[] = [];
    const guard = (raw: unknown, operation: () => void) => {
      try {
        operation();
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        rejected.push(
          createHash('sha256')
            .update(JSON.stringify(raw) ?? 'null')
            .digest('hex'),
        );
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
              for (const raw of list(value.messages))
                guard(raw, () => {
                  const message = object(raw);
                  const from = text(message.from, 15);
                  if (!/^[1-9]\d{6,14}$/.test(from))
                    throw new BadRequestException();
                  const base = {
                    channel: this.channel,
                    providerAccountId: this.config.phoneId,
                    externalMessageId: text(message.id),
                    contact: { phone: `+${from}` },
                    occurredAt: timestamp(message.timestamp).toISOString(),
                  };
                  let command: InboundMessageCommand;
                  if (message.type === 'text') {
                    command = {
                      ...base,
                      type: 'TEXT',
                      content: text(object(message.text).body, 16000),
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
                    ).toUpperCase() as WhatsAppStatus['status'],
                    occurredAt: timestamp(status.timestamp),
                  });
                });
            });
        });
    });
    return { messages, statuses, rejected };
  }
  async sendMessage(to: string, content: string): Promise<string> {
    this.config.assertEnabled();
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
            to: to.replace(/^\+/, ''),
            type: 'text',
            text: { body: content },
          }),
        },
      );
    } catch {
      throw new WhatsAppSendError('unknown');
    }
    // Only an explicit rate-limit rejection is automatically retried. Network/5xx
    // may occur after acceptance; never assume provider-side idempotency.
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 1;
      throw new WhatsAppSendError(
        'retry',
        Math.min(3600000, Math.max(1000, seconds * 1000)),
      );
    }
    if (response.status >= 500 || response.status === 408)
      throw new WhatsAppSendError('unknown');
    if (!response.ok) throw new WhatsAppSendError('failed');
    try {
      const result = object(await response.json());
      return text(object(list(result.messages)[0]).id);
    } catch {
      throw new WhatsAppSendError('unknown');
    }
  }
}
