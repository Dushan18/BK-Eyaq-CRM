import { BadRequestException } from '@nestjs/common';
import { isISO8601, isURL } from 'class-validator';
import { ContactChannel, MessageType } from '../../generated/prisma/enums';
import {
  normalizeContact,
  type ContactInput,
} from '../common/contact-normalization';

export interface InboundAttachment {
  type: 'IMAGE' | 'FILE' | 'OTHER';
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  externalMediaId?: string;
  url?: string;
}
export interface InboundMessageCommand {
  channel: ContactChannel;
  externalMessageId: string;
  externalConversationId?: string;
  providerAccountId?: string;
  contact: ContactInput & { firstName?: string; lastName?: string };
  type: MessageType;
  content?: string;
  occurredAt?: string;
  attachments?: InboundAttachment[];
}
const invalid = (): never => {
  throw new BadRequestException('Comando de mensaje inválido');
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function text(
  value: unknown,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    return invalid();
  return value.trim();
}
// Runtime validation also applies to internal adapters, not only HTTP DTOs.
export function validateInboundMessage(input: unknown): InboundMessageCommand {
  const data = object(input);
  keys(data, [
    'channel',
    'externalMessageId',
    'externalConversationId',
    'providerAccountId',
    'contact',
    'type',
    'content',
    'occurredAt',
    'attachments',
  ]);
  if (
    !Object.values(ContactChannel).includes(data.channel as ContactChannel) ||
    !Object.values(MessageType).includes(data.type as MessageType)
  )
    invalid();
  const contact = object(data.contact);
  keys(contact, ['phone', 'phoneCountry', 'email', 'firstName', 'lastName']);
  const parsedContact = {
    phone: text(contact.phone, 80),
    phoneCountry: text(contact.phoneCountry, 2),
    email: text(contact.email, 320),
    firstName: text(contact.firstName, 100),
    lastName: text(contact.lastName, 100),
  };
  normalizeContact(parsedContact);
  const content = text(data.content, 16000);
  const occurredAt = text(data.occurredAt, 40);
  if (
    occurredAt &&
    (!isISO8601(occurredAt, { strict: true }) ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(occurredAt) ||
      !Number.isFinite(Date.parse(occurredAt)))
  )
    invalid();
  if (
    data.attachments !== undefined &&
    (!Array.isArray(data.attachments) || data.attachments.length > 10)
  )
    invalid();
  const attachments = ((data.attachments ?? []) as unknown[]).map(
    (raw): InboundAttachment => {
      const a = object(raw);
      keys(a, [
        'type',
        'fileName',
        'mimeType',
        'sizeBytes',
        'externalMediaId',
        'url',
      ]);
      if (!['IMAGE', 'FILE', 'OTHER'].includes(a.type as string)) invalid();
      const url = text(a.url, 2048);
      const externalMediaId = text(a.externalMediaId, 255);
      if (!url && !externalMediaId) invalid();
      if (
        url &&
        !isURL(url, {
          protocols: ['https', 'http'],
          require_protocol: true,
          disallow_auth: true,
        })
      )
        invalid();
      if (
        a.sizeBytes !== undefined &&
        (typeof a.sizeBytes !== 'number' ||
          !Number.isInteger(a.sizeBytes) ||
          a.sizeBytes < 0 ||
          a.sizeBytes > 2147483647)
      )
        invalid();
      return {
        type: a.type as InboundAttachment['type'],
        fileName: text(a.fileName, 255),
        mimeType: text(a.mimeType, 150),
        sizeBytes: a.sizeBytes as number | undefined,
        externalMediaId,
        url,
      };
    },
  );
  if (data.type === 'TEXT' && !content) invalid();
  if (
    ['IMAGE', 'FILE'].includes(data.type as string) &&
    !attachments.some((a) => a.type === data.type)
  )
    invalid();
  if (data.type === 'OTHER' && !content && !attachments.length) invalid();
  return {
    channel: data.channel as ContactChannel,
    type: data.type as MessageType,
    externalMessageId: text(data.externalMessageId, 255, true)!,
    externalConversationId: text(data.externalConversationId, 255),
    providerAccountId: text(data.providerAccountId, 80),
    contact: parsedContact,
    content,
    occurredAt,
    attachments,
  };
}
