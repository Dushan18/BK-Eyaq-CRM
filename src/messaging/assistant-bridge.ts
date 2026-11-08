import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { messageSelect } from './messaging.select';

export type ProcessedMessage = Prisma.MessageGetPayload<{
  select: typeof messageSelect;
}>;
export interface AssistantHandler {
  // When true, Samanta answers on her own and an operator reply pauses her.
  readonly autoReplies: boolean;
  // Runs inside the transaction that marks the inbound message PROCESSED.
  inboundProcessed(
    tx: Prisma.TransactionClient,
    message: ProcessedMessage,
  ): Promise<void>;
}

// SamantaModule imports MessagingModule, so messaging cannot inject Samanta directly.
// Samanta registers its handler here on startup.
@Injectable()
export class AssistantBridge {
  handler?: AssistantHandler;
}
