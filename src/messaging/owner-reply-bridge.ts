import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { ProcessedMessage } from './assistant-bridge';

export interface OwnerReplyHandler {
  // Runs inside the transaction that marks the inbound message PROCESSED, before
  // Samanta. Returns true when the message came from the owner and was handled here:
  // then it is not a customer conversation turn and Samanta never sees it.
  inboundProcessed(
    tx: Prisma.TransactionClient,
    message: ProcessedMessage,
  ): Promise<boolean>;
}

// OwnerApprovalModule imports MessagingModule, so messaging cannot inject it directly.
// The owner's reply handler registers itself here on startup (M9.2).
@Injectable()
export class OwnerReplyBridge {
  handler?: OwnerReplyHandler;
}
