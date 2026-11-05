import { Injectable, Logger } from '@nestjs/common';
import { MessengerConfig } from './messenger.config';
import {
  MessengerAdapter,
  type MessengerDeliveryWatermark,
} from './messenger.adapter';
import { MessagesService } from '../messaging/messages.service';
import { MessageStatusService } from '../messaging/message-status.service';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../database/prisma.service';
import type { ChannelDeliveryStatus } from '../messaging/channel-transport';
import { recordContactNames } from '../messaging/contact-names';
import { parseSignedEvent, verifyChallenge } from '../messaging/meta-webhook';

// sentAt is recorded once Meta has answered, so it is never earlier than Meta's acceptance
// (the watermark's clock). The margin absorbs that response latency plus clock skew: a reply
// accepted within it after the watermark may be confirmed along with it, while one whose
// response took longer waits for a later receipt.
export const WATERMARK_TOLERANCE_MS = 2000;

@Injectable()
export class MessengerService {
  private readonly logger = new Logger(MessengerService.name);
  constructor(
    private readonly config: MessengerConfig,
    private readonly adapter: MessengerAdapter,
    private readonly messages: MessagesService,
    private readonly statuses: MessageStatusService,
    private readonly customers: CustomersService,
    private readonly prisma: PrismaService,
  ) {}
  verify(mode: unknown, token: unknown, challenge: unknown) {
    this.config.assertEnabled();
    return verifyChallenge(this.config.verifyToken, mode, token, challenge);
  }
  async receive(raw: Buffer | undefined, signature: string | undefined) {
    this.config.assertEnabled();
    const parsed = this.adapter.parse(
      parseSignedEvent(raw, signature, this.config.appSecret),
    );
    const created = await this.messages.ingestFromProvider(
      parsed.messages,
      parsed.rejected,
    );
    await this.statuses.accept(
      [
        ...parsed.statuses,
        ...(await this.deliveredByWatermark(
          parsed.watermarks,
          parsed.statuses,
        )),
      ],
      'FACEBOOK',
    );
    const named = await recordContactNames(
      created,
      ({ externalMessageId, contact }) =>
        contact.externalId
          ? this.adapter.fetchSenderName(externalMessageId, contact.externalId)
          : null,
      (customerId, name) => this.customers.setNameIfMissing(customerId, name),
    );
    if (!named)
      this.logger.warn(JSON.stringify({ code: 'MESSENGER_NAME_UNAVAILABLE' }));
    if (parsed.rejected.length) {
      await this.messages.quarantine(
        parsed.rejected,
        'MESSENGER_EVENT_INVALID',
      );
      this.logger.warn(
        JSON.stringify({
          code: 'MESSENGER_EVENT_QUARANTINED',
          count: parsed.rejected.length,
        }),
      );
    }
    return { received: true };
  }
  // Every reply sent at or before the watermark was delivered, even if no mids are listed.
  // Evaluated once on arrival and not stored: a reply that is not SENT yet at that moment
  // (still SENDING, or UNKNOWN) is only confirmed by a later receipt.
  private async deliveredByWatermark(
    watermarks: MessengerDeliveryWatermark[],
    listed: ChannelDeliveryStatus[],
  ) {
    const known = new Set(listed.map((status) => status.externalMessageId));
    const statuses: ChannelDeliveryStatus[] = [];
    for (const { recipientId, watermark, occurredAt } of watermarks) {
      const sent = await this.prisma.message.findMany({
        where: {
          channel: 'FACEBOOK',
          direction: 'OUTBOUND',
          status: 'SENT',
          providerAccountId: this.config.pageId,
          recipientExternalId: recipientId,
          externalMessageId: { not: null },
          sentAt: {
            lte: new Date(watermark.getTime() + WATERMARK_TOLERANCE_MS),
          },
        },
        select: { externalMessageId: true, sentAt: true },
        orderBy: { sentAt: 'asc' },
        take: 100,
      });
      for (const { externalMessageId, sentAt } of sent) {
        if (!externalMessageId || known.has(externalMessageId)) continue;
        known.add(externalMessageId);
        statuses.push({
          externalMessageId,
          providerAccountId: this.config.pageId,
          status: 'DELIVERED',
          // Reconcile keeps the earliest times; never date a delivery before its send.
          occurredAt: sentAt && sentAt > occurredAt ? sentAt : occurredAt,
        });
      }
    }
    return statuses;
  }
}
