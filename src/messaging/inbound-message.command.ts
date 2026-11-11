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
  // externalId: a provider-scoped identity (a Messenger PSID) within providerAccountId.
  // whatsapp*: WhatsApp's business-scoped user ID (sent even when the phone is hidden),
  // username (without "@") and profile name.
  contact: ContactInput & {
    firstName?: string;
    lastName?: string;
    externalId?: string;
    whatsappUserId?: string;
    whatsappUsername?: string;
    whatsappProfileName?: string;
  };
  type: MessageType;
  content?: string;
  occurredAt?: string;
  attachments?: InboundAttachment[];
  // WhatsApp: the message this one answers (context.id), and whether it is a button tap
  // rather than typed text. Used to tie the owner's answers to a request (M9.2).
  replyToExternalMessageId?: string;
  buttonReply?: boolean;
}
// BSUID: country prefix plus up to 128 alphanumerics ("US.13491208655302741918").
export const WHATSAPP_USER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
export const WHATSAPP_USERNAME = /^[A-Za-z0-9._]{1,40}$/;
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
    'replyToExternalMessageId',
    'buttonReply',
  ]);
  if (data.buttonReply !== undefined && typeof data.buttonReply !== 'boolean')
    invalid();
  if (
    !Object.values(ContactChannel).includes(data.channel as ContactChannel) ||
    !Object.values(MessageType).includes(data.type as MessageType)
  )
    invalid();
  const contact = object(data.contact);
  keys(contact, [
    'phone',
    'phoneCountry',
    'email',
    'firstName',
    'lastName',
    'externalId',
    'whatsappUserId',
    'whatsappUsername',
    'whatsappProfileName',
  ]);
  const parsedContact = {
    phone: text(contact.phone, 80),
    phoneCountry: text(contact.phoneCountry, 2),
    email: text(contact.email, 320),
    firstName: text(contact.firstName, 100),
    lastName: text(contact.lastName, 100),
    externalId: text(contact.externalId, 80),
    whatsappUserId: text(contact.whatsappUserId, 160),
    whatsappUsername: text(contact.whatsappUsername, 40),
    whatsappProfileName: text(contact.whatsappProfileName, 100),
  };
  const externalId = parsedContact.externalId;
  const whatsappUserId = parsedContact.whatsappUserId;
  // WhatsApp identity only exists on WhatsApp messages, which carry nothing else but the
  // phone: an email or a CRM name there would be silently ignored, so it is rejected.
  if (
    (whatsappUserId !== undefined ||
      parsedContact.whatsappUsername !== undefined ||
      parsedContact.whatsappProfileName !== undefined) &&
    (data.channel !== 'WHATSAPP' ||
      externalId !== undefined ||
      parsedContact.email !== undefined ||
      parsedContact.firstName !== undefined ||
      parsedContact.lastName !== undefined)
  )
    invalid();
  if (
    (whatsappUserId !== undefined && !WHATSAPP_USER_ID.test(whatsappUserId)) ||
    (parsedContact.whatsappUsername !== undefined &&
      !WHATSAPP_USERNAME.test(parsedContact.whatsappUsername))
  )
    invalid();
  // A provider identity is never a phone number in disguise: it is numeric (as the
  // customers CHECK constraint requires), scoped to its account and never mixed with one.
  if (
    externalId !== undefined &&
    (!/^\d+$/.test(externalId) ||
      typeof data.providerAccountId !== 'string' ||
      !/^\d{1,80}$/.test(data.providerAccountId) ||
      parsedContact.phone !== undefined ||
      parsedContact.email !== undefined)
  )
    invalid();
  normalizeContact(parsedContact, {
    allowMissingContact:
      externalId !== undefined || whatsappUserId !== undefined,
  });
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
    replyToExternalMessageId: text(data.replyToExternalMessageId, 255),
    buttonReply: data.buttonReply === true ? true : undefined,
  };
}
