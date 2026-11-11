import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client';
import type {
  ContactChannel,
  MessageStatus,
} from '../../generated/prisma/enums';
import { normalizeContact } from '../common/contact-normalization';
import { CRM_NOTE } from '../common/crm-note';
import { SAMANTA_USER_ID } from '../common/constants/system-users.constants';
import { PrismaService } from '../database/prisma.service';
import { MessagingTransactionService } from '../messaging/messaging-transaction.service';
import { OutboundMessagesService } from '../messaging/outbound-messages.service';
import { recordRequestStatusChange } from '../reservations/reservation-request-history';
import { OwnerApprovalConfig } from './owner-approval.config';

const HOUR_MS = 60 * 60 * 1000;
const BATCH = 20;
// A request whose notification could not be queued is tried again after this.
const RETRY_MS = 10 * 60 * 1000;
// Evidence that WhatsApp took the template (it has a wamid), or more.
const SENT: MessageStatus[] = ['SENT', 'DELIVERED', 'READ'];
// The template did not reach the owner, or nobody knows whether it did.
const NOT_SENT: MessageStatus[] = ['FAILED', 'UNKNOWN'];
const CHANNEL: Record<ContactChannel, string> = {
  WHATSAPP: 'WhatsApp',
  FACEBOOK: 'Messenger',
  INSTAGRAM: 'Instagram',
  WEBSITE: 'Página web',
  PHONE: 'Teléfono',
  EMAIL: 'Correo',
  OTHER: 'Otro',
};
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export interface OwnerTemplateSource {
  code: string;
  externalReference: string | null;
  sourceChannel: ContactChannel;
  reservationAt: Date;
  numberOfPeople: number;
  specialRequirements: string | null;
  comments: string | null;
  customer: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    normalizedPhone: string | null;
  };
  commercialItem: { nameEs: string | null; nameEn: string | null } | null;
}
// The 8 body parameters of the template approved in Meta, and the CRM's rendering of the
// whole message for the history. Keep both in line with the template (docs/frontend-api).
export function ownerTemplate(request: OwnerTemplateSource, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('es-PE', {
      timeZone,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(request.reservationAt)
      .map((part) => [part.type, part.value]),
  );
  const name =
    [request.customer.firstName, request.customer.lastName]
      .filter(Boolean)
      .join(' ') || 'Sin nombre';
  const phone = request.customer.phone ?? request.customer.normalizedPhone;
  // What the customer asked for; the CRM's own notes ("CRM: ...") stay internal.
  const notes = [
    request.specialRequirements,
    ...(request.comments ?? '')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith(CRM_NOTE)),
  ]
    .filter(Boolean)
    .join(' · ');
  const parameters = [
    request.code,
    clip(phone ? `${name} (${phone})` : name, 80),
    `${parts.weekday} ${parts.day}/${parts.month}/${parts.year}`,
    `${parts.hour}:${parts.minute}`,
    String(request.numberOfPeople),
    clip(
      request.commercialItem?.nameEs ?? request.commercialItem?.nameEn ?? '',
      60,
    ) || '-',
    clip(notes, 250) || '-',
    request.externalReference
      ? `${CHANNEL[request.sourceChannel]} (${request.externalReference})`
      : CHANNEL[request.sourceChannel],
  ];
  const [code, client, date, time, people, service, observations, origin] =
    parameters;
  const content = [
    `Nueva solicitud de reserva ${code}`,
    `Cliente: ${client}`,
    `Fecha: ${date}`,
    `Hora: ${time}`,
    `Personas: ${people}`,
    `Servicio: ${service}`,
    `Observaciones: ${observations}`,
    `Origen: ${origin}`,
    'Elige una opción. Con «Proponer cambio», escribe luego la nueva fecha, hora o personas.',
  ].join('\n');
  return { parameters, content };
}

// M9.1: sends each new READY_TO_SEND request from Samanta or the website to the owner's
// WhatsApp (a template, through the regular outbox and its retries) and follows the
// message: SENT_TO_OWNER when queued, WAITING_RESPONSE once WhatsApp accepted it. The
// owner's answer is M9.2; meanwhile a person can still approve or reject (M8.3).
@Injectable()
export class OwnerApprovalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OwnerApprovalService.name);
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running?: Promise<void>;
  private warned = new Set<string>();
  private retryAt = new Map<string, number>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: MessagingTransactionService,
    private readonly outbound: OutboundMessagesService,
    private readonly config: OwnerApprovalConfig,
    private readonly env: ConfigService,
  ) {}
  onModuleInit() {
    if (!this.config.enabled) return;
    // Messages are only sent by the messaging workers.
    if (this.env.get<string>('MESSAGING_ENABLED') !== 'true') {
      this.logger.warn(
        JSON.stringify({ code: 'OWNER_APPROVAL_REQUIRES_MESSAGING' }),
      );
      return;
    }
    this.timer = setInterval(() => this.tick(), this.config.pollSeconds * 1000);
    this.timer.unref();
    this.first = setTimeout(() => this.tick(), 5000);
    this.first.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    await this.running;
  }
  private tick() {
    if (this.running) return;
    this.running = this.runOnce()
      .then(() => undefined)
      .catch(() =>
        this.logger.warn(
          JSON.stringify({ code: 'OWNER_APPROVAL_UNAVAILABLE' }),
        ),
      )
      .finally(() => {
        this.running = undefined;
      });
  }
  private warnOnce(code: string) {
    if (this.warned.has(code)) return;
    this.warned.add(code);
    this.logger.warn(JSON.stringify({ code }));
  }

  // Follows the notifications already queued, then sends the new ones.
  async runOnce() {
    const updated = await this.reconcile();
    const sent = await this.dispatch();
    return { updated, sent };
  }

  async dispatch() {
    if (!this.outbound.canSendTemplates('WHATSAPP')) {
      this.warnOnce('OWNER_APPROVAL_WHATSAPP_DISABLED');
      return 0;
    }
    const owner = await this.prisma.restaurantConfig.findUnique({
      where: { scope: 'GLOBAL' },
      select: { ownerWhatsappNumber: true, approvalResponsibleId: true },
    });
    if (!owner?.ownerWhatsappNumber || !owner.approvalResponsibleId) {
      this.warnOnce('OWNER_APPROVAL_NOT_CONFIGURED');
      return 0;
    }
    this.warned.delete('OWNER_APPROVAL_NOT_CONFIGURED');
    const now = new Date();
    const due = await this.prisma.reservationRequest.findMany({
      where: this.pending(now),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BATCH,
      select: { id: true },
    });
    let sent = 0;
    for (const { id } of due) {
      if ((this.retryAt.get(id) ?? 0) > Date.now()) continue;
      try {
        if (await this.notify(id)) sent += 1;
        this.retryAt.delete(id);
      } catch (error) {
        this.retryAt.set(id, Date.now() + RETRY_MS);
        this.logger.warn(
          JSON.stringify({
            code: 'OWNER_APPROVAL_NOT_QUEUED',
            reservationRequestId: id,
            errorName: error instanceof Error ? error.name : 'Unknown',
          }),
        );
      }
    }
    return sent;
  }

  // New requests from Samanta (a confirmed summary) or the website's email: complete,
  // in the future, recent, and never notified before.
  private pending(now: Date): Prisma.ReservationRequestWhereInput {
    return {
      status: 'READY_TO_SEND',
      ownerMessageId: null,
      reservationAt: { gt: now },
      numberOfPeople: { not: null },
      createdAt: {
        gte: new Date(now.getTime() - this.config.maxAgeHours * HOUR_MS),
      },
      OR: [
        { samantaProposal: { isNot: null } },
        { inboundEmails: { some: {} } },
      ],
    };
  }

  // One request: the template is queued and the request moves to SENT_TO_OWNER in the
  // same transaction, with the request row locked. The message's idempotency key and the
  // unique ownerMessageId keep it to one notification, also with two instances running.
  private notify(id: string) {
    return this.transactions.run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM reservation_requests WHERE id = ${id} FOR UPDATE`;
      const now = new Date();
      const request = await tx.reservationRequest.findFirst({
        where: { id, ...this.pending(now) },
        select: {
          code: true,
          externalReference: true,
          sourceChannel: true,
          reservationAt: true,
          numberOfPeople: true,
          specialRequirements: true,
          comments: true,
          customer: {
            select: {
              firstName: true,
              lastName: true,
              phone: true,
              normalizedPhone: true,
            },
          },
          commercialItem: { select: { nameEs: true, nameEn: true } },
        },
      });
      if (!request?.reservationAt || !request.numberOfPeople) return false;
      const restaurant = await tx.restaurantConfig.findUnique({
        where: { scope: 'GLOBAL' },
        select: { ownerWhatsappNumber: true, timeZone: true },
      });
      if (!restaurant?.ownerWhatsappNumber) return false;
      const conversationId = await this.ownerConversation(
        tx,
        restaurant.ownerWhatsappNumber,
      );
      const { parameters, content } = ownerTemplate(
        {
          ...request,
          reservationAt: request.reservationAt,
          numberOfPeople: request.numberOfPeople,
        },
        restaurant.timeZone,
      );
      const message = await this.outbound.queueTemplateMessage(
        conversationId,
        SAMANTA_USER_ID,
        `owner-approval-${id}`,
        {
          name: this.config.template,
          language: this.config.language,
          parameters,
          content,
        },
        tx,
      );
      await tx.reservationRequest.update({
        where: { id },
        data: { status: 'SENT_TO_OWNER', ownerMessageId: message.id },
      });
      await recordRequestStatusChange(tx, {
        requestId: id,
        previousStatus: 'READY_TO_SEND',
        newStatus: 'SENT_TO_OWNER',
        actor: { type: 'SYSTEM' },
        reason: 'Enviada al WhatsApp del propietario para su aprobación.',
      });
      this.logger.log(
        JSON.stringify({
          code: 'OWNER_APPROVAL_QUEUED',
          reservationRequestId: id,
          messageId: message.id,
        }),
      );
      return true;
    }, true);
  }

  // The owner's WhatsApp conversation. The owner is not a customer, but every message
  // belongs to a conversation of a contact: one contact for the owner's number, with
  // Samanta paused so that she never answers the owner.
  private async ownerConversation(
    tx: Prisma.TransactionClient,
    ownerNumber: string,
  ) {
    const contact = normalizeContact({ phone: ownerNumber });
    const customer =
      (await tx.customer.findUnique({
        where: { normalizedPhone: contact.normalizedPhone! },
        select: { id: true },
      })) ??
      (await tx.customer.create({
        data: {
          firstName: 'Propietario',
          phone: contact.phone,
          phoneCountry: contact.phoneCountry,
          normalizedPhone: contact.normalizedPhone,
          sourceChannel: 'WHATSAPP',
          notes: `${CRM_NOTE}número del propietario para aprobar reservas por WhatsApp; no es un cliente.`,
        },
        select: { id: true },
      }));
    const conversation = await tx.conversation.upsert({
      where: {
        customerId_channel: { customerId: customer.id, channel: 'WHATSAPP' },
      },
      create: {
        customerId: customer.id,
        channel: 'WHATSAPP',
        isAssistantPaused: true,
        assistantPauseReason: 'MANUAL',
        assistantPausedAt: new Date(),
      },
      update: {},
      select: { id: true, isAssistantPaused: true },
    });
    if (!conversation.isAssistantPaused)
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          isAssistantPaused: true,
          assistantPauseReason: 'MANUAL',
          assistantPausedAt: new Date(),
        },
      });
    return conversation.id;
  }

  // WAITING_RESPONSE only with evidence that WhatsApp took the template (SENT, then
  // DELIVERED or READ). If it failed or its fate is unknown, the request goes back to
  // READY_TO_SEND, is not sent again, and a person decides (M8.3).
  async reconcile() {
    const rows = await this.prisma.reservationRequest.findMany({
      where: {
        OR: [
          {
            status: 'SENT_TO_OWNER',
            ownerMessage: { status: { in: [...SENT, ...NOT_SENT] } },
          },
          {
            status: 'WAITING_RESPONSE',
            ownerMessage: { status: { in: NOT_SENT } },
          },
        ],
      },
      take: 50,
      select: { id: true },
    });
    let updated = 0;
    for (const { id } of rows)
      if (await this.follow(id).catch(() => false)) updated += 1;
    return updated;
  }
  private follow(id: string) {
    return this.transactions.run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM reservation_requests WHERE id = ${id} FOR UPDATE`;
      const request = await tx.reservationRequest.findUnique({
        where: { id },
        select: {
          status: true,
          ownerMessage: { select: { status: true, errorCode: true } },
        },
      });
      const message = request?.ownerMessage;
      if (
        !message ||
        (request.status !== 'SENT_TO_OWNER' &&
          request.status !== 'WAITING_RESPONSE')
      )
        return false;
      let next: 'WAITING_RESPONSE' | 'READY_TO_SEND' | null = null;
      let reason = '';
      if (request.status === 'SENT_TO_OWNER' && SENT.includes(message.status)) {
        next = 'WAITING_RESPONSE';
        reason = `WhatsApp aceptó el mensaje al propietario (${message.status}).`;
      } else if (NOT_SENT.includes(message.status)) {
        next = 'READY_TO_SEND';
        reason =
          message.status === 'UNKNOWN'
            ? `No se sabe si el mensaje llegó al propietario (${message.errorCode ?? 'UNKNOWN'}). No se reenvía: apruébala o recházala a mano.`
            : `No se pudo enviar al propietario (${message.errorCode ?? 'FAILED'}). No se reenvía: apruébala o recházala a mano.`;
      }
      if (!next) return false;
      await tx.reservationRequest.update({
        where: { id },
        data: { status: next },
      });
      await recordRequestStatusChange(tx, {
        requestId: id,
        previousStatus: request.status,
        newStatus: next,
        actor: { type: 'SYSTEM' },
        reason: reason.slice(0, 1000),
      });
      return true;
    });
  }
}
