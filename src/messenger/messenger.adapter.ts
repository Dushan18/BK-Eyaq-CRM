import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MessengerConfig } from './messenger.config';
import {
  WhatsAppSendError,
  type WhatsAppStatus,
} from '../whatsapp/whatsapp.adapter';
import { readSendDiagnostic } from '../whatsapp/whatsapp-send-diagnostic';

export interface MessengerInbound {
  pageId: string;
  senderId: string;
  externalMessageId: string;
  occurredAt: Date;
  type: 'TEXT' | 'OTHER';
  content: string;
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
function date(value: unknown): Date {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > Date.now() + 60000
  )
    throw new BadRequestException('Fecha Messenger inválida');
  return new Date(value);
}

@Injectable()
export class MessengerAdapter {
  constructor(private readonly config: MessengerConfig) {}
  parse(event: unknown) {
    const messages: MessengerInbound[] = [];
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
                messages.push({
                  pageId: this.config.pageId,
                  senderId,
                  externalMessageId: text(message.mid),
                  occurredAt: date(item.timestamp),
                  type: message.text === undefined ? 'OTHER' : 'TEXT',
                  content:
                    message.text === undefined
                      ? '[Adjunto de Messenger no compatible todavía]'
                      : text(message.text, 16000),
                });
              } else if (item.delivery !== undefined) {
                const delivery = obj(item.delivery);
                const occurredAt = date(delivery.watermark ?? item.timestamp);
                for (const mid of list(delivery.mids))
                  statuses.push({
                    externalMessageId: text(mid),
                    providerAccountId: this.config.pageId,
                    status: 'DELIVERED',
                    occurredAt,
                  });
              }
              // Read watermarks and postbacks are deliberately unsupported in v1.
            });
        });
    });
    return { messages, statuses, rejected };
  }
  async sendMessage(to: string, content: string): Promise<string> {
    this.config.assertEnabled();
    id(to);
    text(content, 2000);
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
      throw new WhatsAppSendError('unknown');
    }
    // Shared outcome contract with the durable outbox; never blindly resend uncertain POSTs.
    const diagnostic = response.ok
      ? undefined
      : await readSendDiagnostic(response);
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? '1');
      throw new WhatsAppSendError(
        'retry',
        Number.isFinite(seconds)
          ? Math.min(3600000, Math.max(1000, seconds * 1000))
          : 1000,
        diagnostic,
      );
    }
    if (response.status >= 500 || response.status === 408)
      throw new WhatsAppSendError('unknown', 1000, diagnostic);
    if (!response.ok) throw new WhatsAppSendError('failed', 1000, diagnostic);
    try {
      const result = obj(await response.json());
      if (result.recipient_id !== to) throw new Error('Recipient mismatch');
      return text(result.message_id);
    } catch {
      throw new WhatsAppSendError('unknown');
    }
  }
}
