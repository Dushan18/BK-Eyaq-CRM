import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { SAMANTA_USER_ID } from '../common/constants/system-users.constants';
import { CRM_NOTE } from '../common/crm-note';
import { safeName } from '../email/web-reservation.service';
import { OutboundMessagesService } from '../messaging/outbound-messages.service';
import { handOff } from '../samanta/samanta-drafts';
import { readProposal } from '../samanta/samanta-reservations';
import {
  OwnerApprovalConfig,
  type CustomerDecision,
} from './owner-approval.config';

const DAY_MS = 24 * 60 * 60 * 1000;
type Language = 'es' | 'en';
interface Details {
  name: string;
  business: string;
  code: string;
  reservation: string | null;
  date: string | null;
  time: string | null;
  people: string | null;
}
// What the customer reads. Never "confirmed" unless the reservation exists: ACCEPTED is
// queued in the transaction that created it, so it can only be sent after the commit.
// The WhatsApp templates (closed window) have the same text with the details as
// {{1}}..{{n}}, in the order of `parameters` below. Keep both in line with Meta.
const at = (d: Details, language: Language) =>
  language === 'en'
    ? `${d.date ? ` for ${d.date}` : ''}${d.time ? ` at ${d.time}` : ''}`
    : `${d.date ? ` para el ${d.date}` : ''}${d.time ? ` a las ${d.time}` : ''}`;
const texts: Record<
  Language,
  Record<CustomerDecision, (d: Details) => string>
> = {
  es: {
    ACCEPTED: (d) =>
      `Hola ${d.name}, ¡buenas noticias! ${d.business} aprobó tu solicitud ${d.code}. Tu reserva ${d.reservation} está confirmada${at(d, 'es')}, ${d.people}. ¡Te esperamos!`,
    REJECTED: (d) =>
      `Hola ${d.name}, lo sentimos: ${d.business} no pudo aprobar tu solicitud de reserva ${d.code}${at(d, 'es')}. No se registró ninguna reserva. Si quieres buscar otra opción, responde a este mensaje.`,
    MODIFICATION_REQUESTED: (d) =>
      `Hola ${d.name}, ${d.business} revisó tu solicitud de reserva ${d.code}${at(d, 'es')} y propone un cambio. Una persona del equipo te escribirá por aquí para coordinarlo; por ahora la reserva no está confirmada.`,
  },
  en: {
    ACCEPTED: (d) =>
      `Hi ${d.name}, good news! ${d.business} approved your request ${d.code}. Your reservation ${d.reservation} is confirmed${at(d, 'en')}, ${d.people}. We look forward to seeing you!`,
    REJECTED: (d) =>
      `Hi ${d.name}, we are sorry: ${d.business} could not approve your reservation request ${d.code}${at(d, 'en')}. No reservation was made. If you would like another option, reply to this message.`,
    MODIFICATION_REQUESTED: (d) =>
      `Hi ${d.name}, ${d.business} reviewed your reservation request ${d.code}${at(d, 'en')} and proposes a change. A member of our team will write to you here to arrange it; the reservation is not confirmed yet.`,
  },
};
const parameters: Record<CustomerDecision, (d: Details) => (string | null)[]> =
  {
    ACCEPTED: (d) => [
      d.name,
      d.business,
      d.code,
      d.reservation,
      d.date,
      d.time,
      d.people,
    ],
    REJECTED: (d) => [d.name, d.business, d.code, d.date, d.time],
    MODIFICATION_REQUESTED: (d) => [d.name, d.business, d.code, d.date, d.time],
  };

// Why the customer was not told, for the team (CRM note) and the owner's answer.
export const NOT_NOTIFIED: Record<string, string> = {
  NO_CONSENT:
    'no nos escribió por WhatsApp ni dio su WhatsApp en el formulario',
  PERSON_ATTENDING: 'una persona del equipo atiende su conversación',
  WINDOW_CLOSED:
    'pasaron más de 24 h desde su último mensaje y ese canal no admite plantillas',
  TEMPLATES_OFF:
    'pasaron más de 24 h desde su último mensaje y las plantillas de aviso no están activadas',
  INCOMPLETE_FOR_TEMPLATE: 'faltan la fecha, la hora o las personas',
  CHANNEL_DISABLED: 'el canal está desactivado en el servidor',
  NO_RECIPIENT: 'el canal no acepta su contacto',
  OWNER_NUMBER: 'su número es el del propietario',
};
const DECISION: Record<CustomerDecision, string> = {
  ACCEPTED: 'aceptada',
  REJECTED: 'rechazada',
  MODIFICATION_REQUESTED: 'cambio propuesto',
};
// The website import got this far only when the form's WhatsApp was the customer's
// (web-reservation.service): the customer gave us that number for this reservation.
const FORM_PHONE_ACCEPTED = [
  'CONVERSATION_PAUSED',
  'CUSTOMER_WAITING',
  'TEMPLATE_RECENTLY_SENT',
  'INCOMPLETE_FOR_TEMPLATE',
  'DAILY_LIMIT',
  'WHATSAPP_DISABLED',
];

export type CustomerNotice =
  { messageId: string; channel: string; template: boolean } | { error: string };

// M9.3: tells the customer what the owner decided. Runs inside the transaction that
// applied the decision (OwnerReplyService), so the notice is queued in the outbox with
// it and leaves only after the commit; the worker sends, retries and records SENT /
// DELIVERED / FAILED. One notice per request: the decision is applied once, the
// request keeps the notice (or why there is none) and the message's idempotency key is
// `decision-<request>-<status>`.
@Injectable()
export class CustomerNoticeService {
  private readonly logger = new Logger(CustomerNoticeService.name);
  constructor(
    private readonly config: OwnerApprovalConfig,
    private readonly outbound: OutboundMessagesService,
  ) {}

  async decided(
    tx: Prisma.TransactionClient,
    requestId: string,
    decision: CustomerDecision,
  ): Promise<CustomerNotice> {
    const request = await tx.reservationRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: {
        code: true,
        customerId: true,
        conversationId: true,
        reservationAt: true,
        numberOfPeople: true,
        comments: true,
        customerNoticeMessageId: true,
        customerNoticeError: true,
        customerNoticeMessage: {
          select: { channel: true, templateName: true },
        },
        customer: { select: { firstName: true, normalizedPhone: true } },
        reservation: {
          select: { code: true, reservationAt: true, numberOfPeople: true },
        },
        inboundEmails: {
          select: { whatsappMessageId: true, contactError: true },
        },
        samantaProposal: { select: { reservationProposal: true } },
      },
    });
    if (request.customerNoticeMessage)
      return {
        messageId: request.customerNoticeMessageId!,
        channel: request.customerNoticeMessage.channel,
        template: request.customerNoticeMessage.templateName !== null,
      };
    if (request.customerNoticeError)
      return { error: request.customerNoticeError };
    const restaurant = await tx.restaurantConfig.findUniqueOrThrow({
      where: { scope: 'GLOBAL' },
      select: { businessName: true, timeZone: true, ownerWhatsappNumber: true },
    });
    const language: Language =
      readProposal(request.samantaProposal?.reservationProposal)?.language ===
      'en'
        ? 'en'
        : 'es';
    const source =
      decision === 'ACCEPTED' && request.reservation
        ? request.reservation
        : request;
    const details = (lang: Language) =>
      this.details(
        request.customer.firstName,
        restaurant,
        request.code,
        request.reservation?.code ?? null,
        source.reservationAt,
        source.numberOfPeople,
        lang,
      );
    const result = await this.send(tx, requestId, decision, {
      request,
      details: details(language),
      // Templates are always in the configured language: Spanish texts.
      templateDetails: details('es'),
      language,
      ownerNumber: restaurant.ownerWhatsappNumber,
    });
    if ('messageId' in result)
      await tx.reservationRequest.update({
        where: { id: requestId },
        data: { customerNoticeMessageId: result.messageId },
      });
    else {
      const note = `${CRM_NOTE}no se avisó al cliente la decisión del propietario (${DECISION[decision]}): ${NOT_NOTIFIED[result.error] ?? result.error}.`;
      await tx.reservationRequest.update({
        where: { id: requestId },
        data: {
          customerNoticeError: result.error,
          comments: request.comments ? `${request.comments}\n${note}` : note,
        },
      });
    }
    // Never the content or the customer: only what was done.
    this.logger.log(
      JSON.stringify({
        code: 'CUSTOMER_DECISION_NOTICE',
        reservationRequestId: requestId,
        decision,
        ...('messageId' in result
          ? {
              messageId: result.messageId,
              channel: result.channel,
              template: result.template,
            }
          : { error: result.error }),
      }),
    );
    return result;
  }

  private async send(
    tx: Prisma.TransactionClient,
    requestId: string,
    decision: CustomerDecision,
    input: {
      request: {
        customerId: string;
        conversationId: string | null;
        customer: { normalizedPhone: string | null };
        inboundEmails: {
          whatsappMessageId: string | null;
          contactError: string | null;
        }[];
      };
      details: Details;
      templateDetails: Details;
      language: Language;
      ownerNumber: string | null;
    },
  ): Promise<CustomerNotice> {
    const { request, details, language } = input;
    // The owner's conversation is never the customer's.
    if (
      input.ownerNumber &&
      request.customer.normalizedPhone === input.ownerNumber
    )
      return { error: 'OWNER_NUMBER' };
    // Samanta's conversation when the request came from one; otherwise (website) the
    // customer's WhatsApp, if there is one.
    const select = {
      id: true,
      channel: true,
      isAssistantPaused: true,
      assistantPauseReason: true,
      assistantPausedAt: true,
    } as const;
    const conversation = request.conversationId
      ? await tx.conversation.findUniqueOrThrow({
          where: { id: request.conversationId },
          select,
        })
      : await tx.conversation.findUnique({
          where: {
            customerId_channel: {
              customerId: request.customerId,
              channel: 'WHATSAPP',
            },
          },
          select,
        });
    // Same rule as the website contact: a person took this conversation (a manual
    // pause, or any pause from the last 24 h), so they tell the customer.
    if (
      conversation?.isAssistantPaused &&
      (conversation.assistantPauseReason === null ||
        conversation.assistantPauseReason === 'MANUAL' ||
        (conversation.assistantPausedAt !== null &&
          Date.now() - conversation.assistantPausedAt.getTime() < DAY_MS))
    )
      return { error: 'PERSON_ATTENDING' };
    const key = `decision-${requestId}-${decision}`;
    const content = texts[language][decision](details);
    let result: CustomerNotice | null = null;
    if (conversation) {
      // Window open: a normal message in the same conversation.
      try {
        const message = await this.outbound.queueOutboundMessage(
          conversation.id,
          SAMANTA_USER_ID,
          key,
          { type: 'TEXT', content },
          tx,
        );
        result = {
          messageId: message.id,
          channel: conversation.channel,
          template: false,
        };
      } catch (error) {
        // Only reads ran before these checks, so the transaction is still usable.
        if (!(error instanceof HttpException)) throw error;
        if (!(error instanceof ConflictException))
          return { error: this.sendError(error) };
      }
    }
    // Window closed (or no conversation yet): only WhatsApp has templates.
    if (!result) {
      if (conversation && conversation.channel !== 'WHATSAPP')
        return { error: 'WINDOW_CLOSED' };
      result = await this.template(tx, key, decision, input, conversation?.id);
    }
    if (decision === 'MODIFICATION_REQUESTED' && conversation)
      // A person coordinates the change: Samanta steps aside in this conversation.
      await handOff(tx, conversation.id);
    return result;
  }

  // The approved template, only to a WhatsApp the customer gave us: they wrote to us
  // there, or the website form carried it.
  private async template(
    tx: Prisma.TransactionClient,
    key: string,
    decision: CustomerDecision,
    input: Parameters<CustomerNoticeService['send']>[3],
    conversationId: string | undefined,
  ): Promise<CustomerNotice> {
    const { request, templateDetails } = input;
    const wrote =
      conversationId !== undefined &&
      (await tx.message.count({
        where: { conversationId, direction: 'INBOUND' },
      })) > 0;
    const formPhone = request.inboundEmails.some(
      (email) =>
        email.whatsappMessageId !== null ||
        (email.contactError !== null &&
          FORM_PHONE_ACCEPTED.includes(email.contactError)),
    );
    if (!request.customer.normalizedPhone || !(wrote || formPhone))
      return { error: 'NO_CONSENT' };
    if (!this.config.decisionTemplatesEnabled)
      return { error: 'TEMPLATES_OFF' };
    const values = parameters[decision](templateDetails);
    if (values.some((value) => !value))
      return { error: 'INCOMPLETE_FOR_TEMPLATE' };
    if (!this.outbound.canSendTemplates('WHATSAPP'))
      return { error: 'CHANNEL_DISABLED' };
    const conversation =
      conversationId ??
      (
        await tx.conversation.upsert({
          where: {
            customerId_channel: {
              customerId: request.customerId,
              channel: 'WHATSAPP',
            },
          },
          create: { customerId: request.customerId, channel: 'WHATSAPP' },
          update: {},
          select: { id: true },
        })
      ).id;
    try {
      const message = await this.outbound.queueTemplateMessage(
        conversation,
        SAMANTA_USER_ID,
        key,
        {
          name: this.config.decisionTemplates[decision],
          language: this.config.decisionTemplateLanguage,
          parameters: values as string[],
          content: texts.es[decision](templateDetails),
        },
        tx,
      );
      return { messageId: message.id, channel: 'WHATSAPP', template: true };
    } catch (error) {
      // queueTemplateMessage checks before writing, so the transaction is still usable.
      if (!(error instanceof HttpException)) throw error;
      return { error: this.sendError(error) };
    }
  }

  private sendError(error: HttpException) {
    return error instanceof ServiceUnavailableException
      ? 'CHANNEL_DISABLED'
      : 'NO_RECIPIENT';
  }

  private details(
    firstName: string | null,
    restaurant: { businessName: string; timeZone: string },
    code: string,
    reservation: string | null,
    reservationAt: Date | null,
    numberOfPeople: number | null,
    language: Language,
  ): Details {
    const english = language === 'en';
    return {
      name: safeName(firstName) ?? (english ? 'there' : 'cliente'),
      business: restaurant.businessName,
      code,
      reservation,
      date: reservationAt
        ? new Intl.DateTimeFormat(english ? 'en-US' : 'es-PE', {
            timeZone: restaurant.timeZone,
            day: english ? 'numeric' : '2-digit',
            month: english ? 'long' : '2-digit',
            year: 'numeric',
          }).format(reservationAt)
        : null,
      time: reservationAt
        ? new Intl.DateTimeFormat('es-PE', {
            timeZone: restaurant.timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(reservationAt)
        : null,
      people:
        numberOfPeople === null
          ? null
          : english
            ? `${numberOfPeople} ${numberOfPeople === 1 ? 'person' : 'people'}`
            : `${numberOfPeople} ${numberOfPeople === 1 ? 'persona' : 'personas'}`,
    };
  }
}
