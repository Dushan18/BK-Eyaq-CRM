import type { Prisma } from '../../generated/prisma/client';

// Sequence of the newest message that changes what Samanta should answer: anything
// sent to the customer, or a customer message other than an unsupported one
// (reactions, stickers or audio arrive as OTHER and must not discard a reply).
export async function latestActivity(
  tx: Prisma.TransactionClient,
  conversationId: string,
) {
  const row = await tx.message.findFirst({
    where: {
      conversationId,
      OR: [
        { direction: 'OUTBOUND' },
        { direction: 'INBOUND', type: { not: 'OTHER' } },
      ],
    },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  return row?.sequence ?? 0;
}
export const utcDayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
// A call to OpenAI in progress; an expired one no longer holds a slot.
export const activeGeneration = (now: Date) => ({
  status: 'GENERATING' as const,
  generationExpiresAt: { gt: now },
});
// Samanta steps aside so the conversation shows up for a person.
export async function handOff(
  tx: Prisma.TransactionClient,
  conversationId: string,
) {
  await tx.conversation.updateMany({
    where: { id: conversationId, isAssistantPaused: false },
    data: {
      isAssistantPaused: true,
      assistantPauseReason: 'SAMANTA_HANDOFF',
      assistantPausedAt: new Date(),
    },
  });
}
