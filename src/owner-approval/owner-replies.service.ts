import {
  HttpException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { ReservationRequestStatus } from '../../generated/prisma/enums';
import { CRM_NOTE } from '../common/crm-note';
import { SAMANTA_USER_ID } from '../common/constants/system-users.constants';
import type { ProcessedMessage } from '../messaging/assistant-bridge';
import { OutboundMessagesService } from '../messaging/outbound-messages.service';
import {
  OwnerReplyBridge,
  type OwnerReplyHandler,
} from '../messaging/owner-reply-bridge';
import { ReservationRequestsService } from '../reservation-requests/reservation-requests.service';
import { recordRequestStatusChange } from '../reservations/reservation-request-history';
import {
  CustomerNoticeService,
  NOT_NOTIFIED,
  type CustomerNotice,
} from './customer-notice.service';

export type OwnerIntent = 'ACCEPT' | 'REJECT' | 'PROPOSE';
export type OwnerReplyOutcome =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'MODIFICATION_REQUESTED'
  | 'DETAILS_ADDED'
  | 'ALREADY_RESOLVED'
  | 'NOT_APPLICABLE'
  | 'AMBIGUOUS'
  | 'UNKNOWN_REQUEST'
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED'
  | 'NO_ACTION';

// The three quick replies of the template "aprobacion_reserva_propietario" (M9.1).
const BUTTONS: Record<string, OwnerIntent> = {
  ACEPTAR: 'ACCEPT',
  RECHAZAR: 'REJECT',
  'PROPONER CAMBIO': 'PROPOSE',
};
// The short forms (ACEPTO, RECHAZO, CAMBIO) are decisions only right before a code: in a
// sentence they are just words ("acepto si es a las 9", "cambio a las 21:00").
const BEFORE_CODE = '(?= RES-\\d{4}-\\d{6,}\\b)';
const KEYWORDS: [RegExp, OwnerIntent][] = [
  [new RegExp(`\\bACEPTAR\\b|\\bACEPTO${BEFORE_CODE}`), 'ACCEPT'],
  [new RegExp(`\\bRECHAZAR\\b|\\bRECHAZO${BEFORE_CODE}`), 'REJECT'],
  [
    new RegExp(`\\bPROPONER CAMBIO\\b|\\bMODIFICAR\\b|\\bCAMBIO${BEFORE_CODE}`),
    'PROPOSE',
  ],
];
// …or as the whole message, the way the owner answers with WhatsApp's «Responder» on the
// request ("Acepto", "¡Rechazo!", "cambio."). M9.2 only acts on them with that reference.
const SHORT: Record<string, OwnerIntent> = {
  ACEPTO: 'ACCEPT',
  ACEPTAR: 'ACCEPT',
  RECHAZO: 'REJECT',
  RECHAZAR: 'REJECT',
  CAMBIO: 'PROPOSE',
  'PROPONER CAMBIO': 'PROPOSE',
  MODIFICAR: 'PROPOSE',
};
const CODE = /\bRES-\d{4}-\d{6,}\b/g;
const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

// What an answer says, without deciding anything: a button is its exact label; typed
// text may name decisions and request codes anywhere, or be just a short decision.
export function readOwnerReply(content: string, button: boolean) {
  const text = normalize(content);
  const bare = text.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
  const intents: OwnerIntent[] = button
    ? BUTTONS[text]
      ? [BUTTONS[text]]
      : []
    : SHORT[bare]
      ? [SHORT[bare]]
      : KEYWORDS.filter(([pattern]) => pattern.test(text)).map(
          ([, intent]) => intent,
        );
  const codes = [...new Set(text.match(CODE) ?? [])];
  return { intents, codes };
}

const STATUS: Partial<Record<ReservationRequestStatus, string>> = {
  ACCEPTED: 'aceptada',
  REJECTED: 'rechazada',
  CANCELLED: 'cancelada',
  MODIFICATION_REQUESTED: 'con un cambio propuesto',
  RENEGOTIATING: 'en renegociación',
  INCOMPLETE_DATA: 'incompleta',
};
const CHANNEL: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  FACEBOOK: 'Messenger',
  INSTAGRAM: 'Instagram',
};
// Fixed texts to the owner. None of them reaches a customer (M9.3 writes those).
export const ownerTexts = {
  accepted: (code: string, reservation: string) =>
    `Listo: la solicitud ${code} quedó ACEPTADA y la reserva ${reservation} ya está en el calendario.`,
  rejected: (code: string) =>
    `Listo: la solicitud ${code} quedó RECHAZADA. No se creó ninguna reserva.`,
  propose: (code: string) =>
    `Anotado: propones un cambio para la solicitud ${code}. Escribe en un mensaje la nueva fecha, hora o personas; el equipo lo coordinará con el cliente.`,
  details: (code: string) =>
    `Gracias: agregué tu propuesta a la solicitud ${code}. El equipo la revisará.`,
  already: (code: string, status: ReservationRequestStatus) =>
    `La solicitud ${code} ya está ${STATUS[status] ?? 'resuelta'}; no se cambió nada.`,
  notApplied: (code: string, reason: string) =>
    `No se aplicó tu respuesta a la solicitud ${code}: ${reason}. El equipo la revisará en el CRM.`,
  needCode:
    'No pude identificar la solicitud. Mantén pulsado el mensaje de la solicitud, elige «Responder» y escribe ACEPTO, RECHAZO o CAMBIO. También puedes escribir la decisión con su código (por ejemplo, ACEPTAR RES-2026-000043).',
  // A reply to a message that is not a request sent to this owner (an answer of the
  // backend, an old text, a customer's message...).
  notARequest:
    'El mensaje al que respondiste no es una solicitud de reserva pendiente. Mantén pulsado el mensaje de la solicitud, elige «Responder» y escribe ACEPTO, RECHAZO o CAMBIO.',
  unknownCode: (code: string) =>
    `No encontré una solicitud enviada a ti con el código ${code}. Revisa el código o responde con los botones del mensaje de la solicitud.`,
  ambiguous:
    'Tu mensaje menciona varias solicitudes o varias decisiones. Responde a una solicitud a la vez: con sus botones, o con ACEPTAR, RECHAZAR o PROPONER CAMBIO y su código.',
  notConfigured:
    'No se aplicó tu respuesta porque falta configurar el responsable de aprobación en el CRM. El equipo la revisará.',
  // M9.3: whether the customer is being told.
  notice: (notice: CustomerNotice) =>
    'messageId' in notice
      ? `Le avisamos al cliente por ${CHANNEL[notice.channel] ?? notice.channel}.`
      : `No se pudo avisar al cliente (${NOT_NOTIFIED[notice.error] ?? notice.error}); el equipo debe contactarlo.`,
};

interface Decision {
  outcome: OwnerReplyOutcome;
  reply: string | null;
  requestId?: string;
}
interface OwnerMessage {
  id: string;
  conversationId: string;
  type: string;
  content: string | null;
  replyToExternalMessageId: string | null;
  isButtonReply: boolean;
}
const OPEN: ReservationRequestStatus[] = [
  'READY_TO_SEND',
  'SENT_TO_OWNER',
  'WAITING_RESPONSE',
];

// M9.2: the owner's WhatsApp answers. Runs inside the transaction that marks the inbound
// message PROCESSED (MessageProcessorService), before Samanta: a message from the owner's
// number is never a customer turn. Decisions reuse M8.3 (approveIn / rejectIn) with
// actorType OWNER and the approval responsible. A webhook sent twice is one message
// (unique externalMessageId), and each message is processed once, so a decision is never
// applied twice; concurrent answers are serialized on the request row.
@Injectable()
export class OwnerReplyService
  implements OwnerReplyHandler, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OwnerReplyService.name);
  constructor(
    private readonly bridge: OwnerReplyBridge,
    private readonly requests: ReservationRequestsService,
    private readonly outbound: OutboundMessagesService,
    private readonly notices: CustomerNoticeService,
  ) {}
  onModuleInit() {
    this.bridge.handler = this;
  }
  onModuleDestroy() {
    if (this.bridge.handler === this) this.bridge.handler = undefined;
  }

  async inboundProcessed(
    tx: Prisma.TransactionClient,
    processed: ProcessedMessage,
  ): Promise<boolean> {
    if (processed.direction !== 'INBOUND' || processed.channel !== 'WHATSAPP')
      return false;
    const config = await tx.restaurantConfig.findUnique({
      where: { scope: 'GLOBAL' },
      select: {
        ownerWhatsappNumber: true,
        approvalResponsibleId: true,
        timeZone: true,
      },
    });
    if (!config?.ownerWhatsappNumber) return false;
    const message = await tx.message.findUnique({
      where: { id: processed.id },
      select: {
        id: true,
        conversationId: true,
        type: true,
        content: true,
        // For inbound messages, the sender's phone as WhatsApp reported it.
        recipientPhone: true,
        replyToExternalMessageId: true,
        isButtonReply: true,
      },
    });
    // Identity: the phone WhatsApp reports for the sender is the configured one.
    if (!message || message.recipientPhone !== config.ownerWhatsappNumber)
      return false;
    // From here on it is the owner: Samanta stays out of this conversation.
    await tx.conversation.updateMany({
      where: { id: message.conversationId, isAssistantPaused: false },
      data: {
        isAssistantPaused: true,
        assistantPauseReason: 'MANUAL',
        assistantPausedAt: new Date(),
      },
    });
    const decision = await this.decide(
      tx,
      message,
      config.approvalResponsibleId,
      config.timeZone,
    );
    await tx.message.update({
      where: { id: message.id },
      data: { ownerReplyOutcome: decision.outcome },
    });
    if (decision.reply) await this.answer(tx, message, decision.reply);
    // Never the content: only what was done.
    this.logger.log(
      JSON.stringify({
        code: 'OWNER_REPLY',
        messageId: message.id,
        outcome: decision.outcome,
        reservationRequestId: decision.requestId ?? null,
      }),
    );
    return true;
  }

  private async decide(
    tx: Prisma.TransactionClient,
    message: OwnerMessage,
    ownerUserId: string | null,
    timeZone: string,
  ): Promise<Decision> {
    if (message.type !== 'TEXT' || !message.content?.trim())
      return { outcome: 'UNSUPPORTED', reply: null };
    const { intents, codes } = readOwnerReply(
      message.content,
      message.isButtonReply,
    );
    if (codes.length > 1 || intents.length > 1)
      return { outcome: 'AMBIGUOUS', reply: ownerTexts.ambiguous };
    // Only requests sent to this owner, in this conversation, can be answered.
    const select = { id: true, code: true } as const;
    const quoted = message.replyToExternalMessageId
      ? await tx.reservationRequest.findFirst({
          where: {
            ownerMessage: {
              externalMessageId: message.replyToExternalMessageId,
              conversationId: message.conversationId,
            },
          },
          select,
        })
      : null;
    const coded = codes[0]
      ? await tx.reservationRequest.findFirst({
          where: {
            code: codes[0],
            ownerMessage: { conversationId: message.conversationId },
          },
          select,
        })
      : null;
    if (codes[0] && !coded)
      return {
        outcome: 'UNKNOWN_REQUEST',
        reply: ownerTexts.unknownCode(codes[0]),
      };
    if (quoted && coded && quoted.id !== coded.id)
      return { outcome: 'AMBIGUOUS', reply: ownerTexts.ambiguous };
    const intent = intents[0];
    if (intent) {
      // A button carries the message it answers. Typed text names the code or answers
      // (WhatsApp «Responder», context.id) the exact message of a request sent to this
      // owner in this conversation. Without either, nothing is decided.
      const target = message.isButtonReply ? quoted : (coded ?? quoted);
      if (!target)
        return message.isButtonReply
          ? { outcome: 'UNKNOWN_REQUEST', reply: ownerTexts.needCode }
          : message.replyToExternalMessageId
            ? { outcome: 'UNKNOWN_REQUEST', reply: ownerTexts.notARequest }
            : { outcome: 'AMBIGUOUS', reply: ownerTexts.needCode };
      if (!ownerUserId)
        return {
          outcome: 'NOT_CONFIGURED',
          reply: ownerTexts.notConfigured,
          requestId: target.id,
        };
      return this.apply(tx, target, intent, ownerUserId);
    }
    // No decision: the details of a change the owner proposed.
    let target = coded ?? quoted;
    if (!target) {
      const proposed = await tx.reservationRequest.findMany({
        where: {
          status: 'MODIFICATION_REQUESTED',
          ownerMessage: { conversationId: message.conversationId },
          updatedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
        },
        take: 2,
        select,
      });
      if (proposed.length > 1)
        return { outcome: 'AMBIGUOUS', reply: ownerTexts.needCode };
      target = proposed[0] ?? null;
    }
    if (!target) return { outcome: 'NO_ACTION', reply: null };
    return this.addDetails(tx, target, message.content, timeZone);
  }

  private async apply(
    tx: Prisma.TransactionClient,
    target: { id: string; code: string },
    intent: OwnerIntent,
    ownerUserId: string,
  ): Promise<Decision> {
    await tx.$queryRaw`SELECT id FROM reservation_requests WHERE id = ${target.id} FOR UPDATE`;
    const { status } = await tx.reservationRequest.findUniqueOrThrow({
      where: { id: target.id },
      select: { status: true },
    });
    const base = { requestId: target.id };
    if (!OPEN.includes(status))
      return {
        ...base,
        outcome: 'ALREADY_RESOLVED',
        reply: ownerTexts.already(target.code, status),
      };
    const actor = { type: 'OWNER' as const, id: ownerUserId };
    let applied: Decision & {
      requestId: string;
      outcome: 'ACCEPTED' | 'REJECTED';
    };
    try {
      if (intent === 'ACCEPT') {
        const { reservation } = await this.requests.approveIn(
          tx,
          target.id,
          actor,
        );
        applied = {
          ...base,
          outcome: 'ACCEPTED',
          reply: ownerTexts.accepted(target.code, reservation.code),
        };
      } else if (intent === 'REJECT') {
        await this.requests.rejectIn(
          tx,
          target.id,
          'Rechazada por el propietario por WhatsApp.',
          actor,
        );
        applied = {
          ...base,
          outcome: 'REJECTED',
          reply: ownerTexts.rejected(target.code),
        };
      } else return this.propose(tx, target, status, actor);
    } catch (error) {
      // M8.3 refuses before writing anything (past date, item withdrawn...).
      if (!(error instanceof HttpException)) throw error;
      return {
        ...base,
        outcome: 'NOT_APPLICABLE',
        reply: ownerTexts.notApplied(
          target.code,
          error.message.replace(/[.:]+$/, ''),
        ),
      };
    }
    return this.withNotice(tx, applied);
  }

  private async propose(
    tx: Prisma.TransactionClient,
    target: { id: string; code: string },
    status: ReservationRequestStatus,
    actor: { type: 'OWNER'; id: string },
  ): Promise<Decision> {
    await tx.reservationRequest.update({
      where: { id: target.id },
      data: { status: 'MODIFICATION_REQUESTED' },
    });
    await recordRequestStatusChange(tx, {
      requestId: target.id,
      previousStatus: status,
      newStatus: 'MODIFICATION_REQUESTED',
      actor,
      reason: 'El propietario propuso un cambio por WhatsApp.',
    });
    return this.withNotice(tx, {
      requestId: target.id,
      outcome: 'MODIFICATION_REQUESTED',
      reply: ownerTexts.propose(target.code),
    });
  }

  // M9.3: the customer is told in the same transaction (queued, sent after the commit),
  // and the owner learns whether that was possible.
  private async withNotice(
    tx: Prisma.TransactionClient,
    decision: Decision & {
      requestId: string;
      outcome: 'ACCEPTED' | 'REJECTED' | 'MODIFICATION_REQUESTED';
    },
  ): Promise<Decision> {
    const notice = await this.notices.decided(
      tx,
      decision.requestId,
      decision.outcome,
    );
    return {
      ...decision,
      reply: `${decision.reply} ${ownerTexts.notice(notice)}`,
    };
  }

  // The owner's proposal is kept for the team as a CRM note (hidden from Samanta). The
  // date, the party size and the service are never changed from it.
  private async addDetails(
    tx: Prisma.TransactionClient,
    target: { id: string; code: string },
    content: string,
    timeZone: string,
  ): Promise<Decision> {
    await tx.$queryRaw`SELECT id FROM reservation_requests WHERE id = ${target.id} FOR UPDATE`;
    const request = await tx.reservationRequest.findUniqueOrThrow({
      where: { id: target.id },
      select: { status: true, comments: true },
    });
    if (request.status !== 'MODIFICATION_REQUESTED')
      return { outcome: 'NO_ACTION', reply: null, requestId: target.id };
    const at = new Intl.DateTimeFormat('es-PE', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date());
    const note = `${CRM_NOTE}propuesta del propietario (${at}): ${content.replace(/\s+/g, ' ').trim().slice(0, 500)}`;
    await tx.reservationRequest.update({
      where: { id: target.id },
      data: {
        comments: request.comments ? `${request.comments}\n${note}` : note,
      },
    });
    return {
      outcome: 'DETAILS_ADDED',
      reply: ownerTexts.details(target.code),
      requestId: target.id,
    };
  }

  // A short answer in the owner's conversation (the 24-hour window is open: the owner
  // just wrote). If the channel refuses it, the decision still stands.
  private async answer(
    tx: Prisma.TransactionClient,
    message: OwnerMessage,
    content: string,
  ) {
    try {
      await this.outbound.queueOutboundMessage(
        message.conversationId,
        SAMANTA_USER_ID,
        `owner-reply-${message.id}`,
        { type: 'TEXT', content },
        tx,
      );
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.logger.warn(
        JSON.stringify({
          code: 'OWNER_REPLY_ANSWER_NOT_QUEUED',
          messageId: message.id,
        }),
      );
    }
  }
}
