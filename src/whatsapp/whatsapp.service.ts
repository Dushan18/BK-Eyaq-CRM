import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppConfig } from './whatsapp.config';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { MessagesService } from '../messaging/messages.service';
import { MessageStatusService } from '../messaging/message-status.service';
import { CustomersService } from '../customers/customers.service';
import { recordContactNames } from '../messaging/contact-names';
import { parseSignedEvent, verifyChallenge } from '../messaging/meta-webhook';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  constructor(
    private readonly config: WhatsAppConfig,
    private readonly adapter: WhatsAppAdapter,
    private readonly messages: MessagesService,
    private readonly statuses: MessageStatusService,
    private readonly customers: CustomersService,
  ) {}
  verify(mode: unknown, token: unknown, challenge: unknown): string {
    this.config.assertEnabled();
    return verifyChallenge(this.config.verifyToken, mode, token, challenge);
  }
  async receive(raw: Buffer | undefined, signature: string | undefined) {
    this.config.assertEnabled();
    const parsed = this.adapter.parse(
      parseSignedEvent(raw, signature, this.config.appSecret),
    );
    // A reissued BSUID moves first, so the sender's next messages find their customer.
    for (const { previous, current } of parsed.userIdChanges)
      await this.customers.replaceWhatsAppUserId(previous, current);
    const created = await this.messages.ingestFromProvider(
      parsed.messages,
      parsed.rejected,
    );
    await this.statuses.accept(parsed.statuses, 'WHATSAPP');
    // The CRM name starts as the username ("@ana.q") or else the profile name. Both come in
    // the webhook itself: no call to Meta, so no per-webhook limit.
    const named = await recordContactNames(
      created,
      ({ contact }) =>
        contact.whatsappUsername
          ? `@${contact.whatsappUsername}`
          : (contact.whatsappProfileName ?? null),
      (customerId, name) => this.customers.setNameIfMissing(customerId, name),
      Number.POSITIVE_INFINITY,
    );
    if (!named)
      this.logger.warn(JSON.stringify({ code: 'WHATSAPP_NAME_UNAVAILABLE' }));
    if (parsed.rejected.length) {
      await this.messages.quarantine(parsed.rejected, 'WHATSAPP_EVENT_INVALID');
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
