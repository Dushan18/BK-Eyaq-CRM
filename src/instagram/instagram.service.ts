import { Injectable, Logger } from '@nestjs/common';
import { InstagramConfig } from './instagram.config';
import { InstagramAdapter } from './instagram.adapter';
import { MessagesService } from '../messaging/messages.service';
import { CustomersService } from '../customers/customers.service';
import { recordContactNames } from '../messaging/contact-names';
import { parseSignedEvent, verifyChallenge } from '../messaging/meta-webhook';

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  constructor(
    private readonly config: InstagramConfig,
    private readonly adapter: InstagramAdapter,
    private readonly messages: MessagesService,
    private readonly customers: CustomersService,
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
    // Shared ingestion persists before acknowledging and deduplicates provider message IDs.
    // Transient persistence failures propagate so Meta can retry.
    const created = await this.messages.ingestFromProvider(
      parsed.messages,
      parsed.rejected,
    );
    const named = await recordContactNames(
      created,
      ({ contact }) =>
        contact.externalId
          ? this.adapter.fetchSenderName(contact.externalId)
          : null,
      (customerId, name) => this.customers.setNameIfMissing(customerId, name),
    );
    if (!named)
      this.logger.warn(JSON.stringify({ code: 'INSTAGRAM_NAME_UNAVAILABLE' }));
    if (parsed.rejected.length) {
      await this.messages.quarantine(
        parsed.rejected,
        'INSTAGRAM_EVENT_INVALID',
      );
      this.logger.warn(
        JSON.stringify({
          code: 'INSTAGRAM_EVENT_QUARANTINED',
          count: parsed.rejected.length,
        }),
      );
    }
    return { received: true };
  }
}
