import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { WhatsAppConfig } from './whatsapp.config';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { MessagesService } from '../messaging/messages.service';
import { MessageStatusService } from '../messaging/message-status.service';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  constructor(
    private readonly config: WhatsAppConfig,
    private readonly adapter: WhatsAppAdapter,
    private readonly messages: MessagesService,
    private readonly statuses: MessageStatusService,
    private readonly prisma: PrismaService,
  ) {}
  verify(mode: unknown, token: unknown, challenge: unknown): string {
    this.config.assertEnabled();
    const expected = Buffer.from(this.config.verifyToken);
    const received = Buffer.from(typeof token === 'string' ? token : '');
    if (
      mode !== 'subscribe' ||
      typeof challenge !== 'string' ||
      !challenge ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      throw new ForbiddenException('Verificación inválida');
    return challenge;
  }
  async receive(
    raw: Buffer | undefined,
    signature: string | undefined,
    body: unknown,
  ) {
    this.config.assertEnabled();
    if (!raw || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
      throw new ForbiddenException('Firma inválida');
    const expected = createHmac('sha256', this.config.appSecret)
      .update(raw)
      .digest();
    const received = Buffer.from(signature.slice(7), 'hex');
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      throw new ForbiddenException('Firma inválida');
    const parsed = this.adapter.parse(body);
    for (const command of parsed.messages) {
      try {
        await this.messages.ingestInboundMessage(command);
      } catch (error) {
        if (
          !(error instanceof BadRequestException) &&
          !(error instanceof ConflictException)
        )
          throw error;
        // Transient transaction contention must cause provider retry, not quarantine.
        if (
          error instanceof ConflictException &&
          error.message !==
            'El identificador del mensaje pertenece a otra identidad'
        )
          throw error;
        parsed.rejected.push(
          createHash('sha256').update(JSON.stringify(command)).digest('hex'),
        );
      }
    }
    await this.statuses.accept(parsed.statuses);
    if (parsed.rejected.length) {
      await this.prisma.messagingWebhookRejection.createMany({
        data: parsed.rejected.map((fingerprint) => ({
          fingerprint,
          code: 'WHATSAPP_EVENT_INVALID',
        })),
        skipDuplicates: true,
      });
      this.logger.warn(
        JSON.stringify({
          code: 'WHATSAPP_EVENT_QUARANTINED',
          count: parsed.rejected.length,
        }),
      );
    }
    return { received: true };
  }
}
