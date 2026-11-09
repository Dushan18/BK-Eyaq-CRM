import { Inject, Injectable } from '@nestjs/common';
import type { ContactChannel } from '../../generated/prisma/enums';
import type { SendDiagnostic } from './send-diagnostic';

export interface ChannelDeliveryStatus {
  externalMessageId: string;
  providerAccountId: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  occurredAt: Date;
}
// Shared outcome contract with the durable outbox. Only an explicit rate limit ('retry')
// is resent automatically; 'unknown' may already have been accepted and is never repeated.
export class ChannelSendError extends Error {
  constructor(
    readonly outcome: 'retry' | 'failed' | 'unknown',
    readonly retryAfterMs = 1000,
    readonly diagnostic?: SendDiagnostic,
  ) {
    super(`CHANNEL_SEND_${outcome.toUpperCase()}`);
  }
}
export function isRetryableSendError(
  error: unknown,
): error is ChannelSendError {
  return error instanceof ChannelSendError && error.outcome === 'retry';
}
export interface ChannelRecipientSource {
  normalizedPhone: string | null;
  providerAccountId: string | null;
  externalContactId: string | null;
  whatsappUserId: string | null;
}
// Where a reply can go. recipientOf may return both fields (WhatsApp: phone and BSUID) as
// candidates; the outbox keeps only the first one, phone first, that wrote in the last 24
// hours, so a reply never goes to an address the customer has not written from.
export interface ChannelAddress {
  recipientPhone: string | null;
  recipientExternalId: string | null;
}
// A pre-approved provider template: the only way to write first, or outside the window.
export interface OutboundTemplate {
  name: string;
  language: string;
  // Positional body parameters, {{1}}, {{2}}...
  parameters: string[];
}
// Everything the outbox needs from a provider, so the core never branches on channel names.
export interface ChannelTransport {
  readonly channel: ContactChannel;
  /** Prefix of the channel's error codes, e.g. WHATSAPP_SEND_REJECTED. */
  readonly errorPrefix: string;
  readonly label: string;
  readonly maxTextLength: number;
  /** UTF-8 byte limit, for channels that count bytes (Instagram). */
  readonly maxTextBytes?: number;
  readonly windowClosedMessage: string;
  readonly enabled: boolean;
  readonly providerAccountId: string;
  assertEnabled(): void;
  recipientOf(customer: ChannelRecipientSource): ChannelAddress | null;
  sendMessage(to: ChannelAddress, content: string): Promise<string>;
  /** Only channels with approved templates (WhatsApp). */
  sendTemplate?(
    to: ChannelAddress,
    template: OutboundTemplate,
  ): Promise<string>;
}

export function exceedsTextLimit(
  transport: Pick<ChannelTransport, 'maxTextLength' | 'maxTextBytes'>,
  content: string,
) {
  return (
    content.length > transport.maxTextLength ||
    (transport.maxTextBytes !== undefined &&
      Buffer.byteLength(content, 'utf8') > transport.maxTextBytes)
  );
}

export const CHANNEL_TRANSPORTS = Symbol('CHANNEL_TRANSPORTS');

@Injectable()
export class ChannelTransports {
  constructor(
    @Inject(CHANNEL_TRANSPORTS) private readonly transports: ChannelTransport[],
  ) {}
  find(channel: ContactChannel): ChannelTransport | undefined {
    return this.transports.find((transport) => transport.channel === channel);
  }
  get anyEnabled() {
    return this.transports.some((transport) => transport.enabled);
  }
  errorPrefix(channel: ContactChannel) {
    return this.find(channel)?.errorPrefix ?? channel;
  }
}
