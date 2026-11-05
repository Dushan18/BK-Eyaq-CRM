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
}
// Everything the outbox needs from a provider, so the core never branches on channel names.
export interface ChannelTransport {
  readonly channel: ContactChannel;
  /** Prefix of the channel's error codes, e.g. WHATSAPP_SEND_REJECTED. */
  readonly errorPrefix: string;
  readonly label: string;
  readonly maxTextLength: number;
  readonly windowClosedMessage: string;
  /** Message column that stores the customer's address on this channel. */
  readonly recipientField: 'recipientPhone' | 'recipientExternalId';
  readonly enabled: boolean;
  readonly providerAccountId: string;
  assertEnabled(): void;
  recipientOf(customer: ChannelRecipientSource): string | null;
  sendMessage(to: string, content: string): Promise<string>;
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
