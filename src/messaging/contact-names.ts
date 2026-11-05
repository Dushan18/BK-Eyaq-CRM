import type { InboundMessageCommand } from './inbound-message.command';

// Each lookup is capped at 2 s and they run in parallel, keeping the webhook well inside
// Meta's response budget even when several new customers arrive in one batch.
export const NAME_LOOKUPS_PER_WEBHOOK = 3;

export interface StoredInboundMessage {
  command: InboundMessageCommand;
  customer: { id: string; firstName: string | null; lastName: string | null };
}

// Names customers still without one from the sender of their first stored message.
// Never overwrites a name set in the CRM; a failed lookup is retried on the next message.
// Lookups never fail the webhook: resolves to false when one of them failed, for logging.
// `limit` bounds the lookups that call Meta; names read from the webhook itself need none.
export async function recordContactNames(
  stored: StoredInboundMessage[],
  lookup: (
    command: InboundMessageCommand,
  ) => Promise<string | null> | string | null,
  setNameIfMissing: (customerId: string, name: string) => Promise<unknown>,
  limit = NAME_LOOKUPS_PER_WEBHOOK,
): Promise<boolean> {
  const pending = new Map<string, InboundMessageCommand>();
  for (const { command, customer } of stored)
    if (!customer.firstName && !customer.lastName && !pending.has(customer.id))
      pending.set(customer.id, command);
  const results = await Promise.allSettled(
    [...pending].slice(0, limit).map(async ([customerId, command]) => {
      const name = await lookup(command);
      if (name) await setNameIfMissing(customerId, name);
    }),
  );
  return results.every((result) => result.status === 'fulfilled');
}
