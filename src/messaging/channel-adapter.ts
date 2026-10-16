import type { ContactChannel } from '../../generated/prisma/enums';
import type { InboundMessageCommand } from './inbound-message.command';

// Provider implementations must authenticate their events before calling ingestion.
// WhatsApp is the first runtime adapter; other channels remain out of scope.
export interface MessagingChannelAdapter {
  readonly channel: ContactChannel;
  parseInboundEvent(
    authenticatedEvent: unknown,
  ): Promise<InboundMessageCommand[]>;
}
