import type { Prisma } from '../../generated/prisma/client';
import type { DraftOutput } from './samanta.provider';
import { replies } from './samanta-reservations';

// Text for a reply whose content the model left empty (only allowed with a PROPOSE or
// CONFIRM action): what reaches a draft, a person or the customer is never empty and
// never says the reservation is confirmed. A sent summary or registration replaces it.
export function replyText(output: DraftOutput) {
  if (output.content.trim()) return output.content;
  const text = replies[output.reservation?.language ?? 'es'];
  return output.requiresHuman ? text.emptyHandOff : text.emptyReply;
}

// The model's answer as stored on a draft. `reservation` is an instruction for the
// backend, not a column: what it did is stored by the reservation flow.
export const draftFields = (output: DraftOutput) => ({
  content: replyText(output),
  intent: output.intent,
  requiresHuman: output.requiresHuman,
  missingFields: output.missingFields,
  inputTokens: output.inputTokens,
  outputTokens: output.outputTokens,
});

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
