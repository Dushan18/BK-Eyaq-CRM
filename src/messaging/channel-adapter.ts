import type { ContactChannel } from '../../generated/prisma/enums';
import type { InboundMessageCommand } from './inbound-message.command';

// Inbound half of a channel: translate authenticated provider events into commands for the
// shared ingestion (MessagesService). The outbound half is ChannelTransport.
export interface MessagingChannelAdapter {
  readonly channel: ContactChannel;
  parseInboundEvent(
    authenticatedEvent: unknown,
  ): Promise<InboundMessageCommand[]>;
}
