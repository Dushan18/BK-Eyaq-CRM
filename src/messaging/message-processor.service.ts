import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { MessagingTransactionService } from './messaging-transaction.service';
import { messageSelect } from './messaging.select';
import type { Prisma } from '../../generated/prisma/client';

export const MESSAGE_ATTEMPTS = 5;
export const MESSAGE_LEASE_MS = 60000;
export class TerminalMessageError extends Error {
  constructor() {
    super('MESSAGE_INVALID');
  }
}
export class TemporaryMessageError extends Error {
  constructor() {
    super('MESSAGE_PROCESSING_TEMPORARY');
  }
}
type StoredMessage = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

@Injectable()
export class MessagePreparationService {
  // No network, AI or outbound effects in Phase 1. Extension point for pure preparation.
  prepare(message: StoredMessage): Promise<void> {
    if (
      (message.type === 'TEXT' && !message.content?.trim()) ||
      (['IMAGE', 'FILE'].includes(message.type) &&
        !message.attachments.some((a) => a.type === message.type)) ||
      (message.type === 'OTHER' &&
        !message.content &&
        !message.attachments.length)
    )
      throw new TerminalMessageError();
    return Promise.resolve();
  }
}

@Injectable()
export class MessageProcessorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: MessagingTransactionService,
    private readonly preparation: MessagePreparationService,
  ) {}

  async process(messageId: string): Promise<'processed' | 'terminal' | 'busy'> {
    const token = randomUUID();
    const claimed = await this.transactions.run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM messages WHERE id = ${messageId} FOR UPDATE`;
      const message = await tx.message.findUnique({ where: { id: messageId } });
      if (
        !message ||
        message.direction !== 'INBOUND' ||
        ['PROCESSED', 'FAILED'].includes(message.status)
      )
        return 'terminal' as const;
      const now = new Date();
      if (
        message.status === 'PROCESSING' &&
        message.processingUntil &&
        message.processingUntil > now
      )
        return 'busy' as const;
      if (message.processingAttempts >= MESSAGE_ATTEMPTS) {
        await this.fail(tx, messageId, 'MESSAGE_ATTEMPTS_EXHAUSTED');
        return 'terminal' as const;
      }
      return tx.message.update({
        where: { id: messageId },
        data: {
          status: 'PROCESSING',
          processingToken: token,
          processingUntil: new Date(now.getTime() + MESSAGE_LEASE_MS),
          processingAttempts: { increment: 1 },
        },
        select: messageSelect,
      });
    });
    if (typeof claimed === 'string') return claimed;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      // Renew only a still-valid lease. A stale worker can never revive its claim.
      heartbeat = setInterval(() => {
        void this.renew(messageId, token).catch(() => undefined);
      }, MESSAGE_LEASE_MS / 3);
      heartbeat.unref();
      await this.preparation.prepare(claimed);
      return await this.transactions.run(async (tx) => {
        const updated = await tx.message.updateMany({
          where: {
            id: messageId,
            status: 'PROCESSING',
            processingToken: token,
            processingUntil: { gt: new Date() },
          },
          data: {
            status: 'PROCESSED',
            processedAt: new Date(),
            processingToken: null,
            processingUntil: null,
            errorCode: null,
            errorReason: null,
          },
        });
        if (!updated.count) return 'busy' as const;
        await tx.messagingOutbox.update({
          where: { messageId },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: null,
          },
        });
        // TODO: MESSAGE_PROCESSED audit, committed with DB effects.
        return 'processed' as const;
      });
    } catch (error) {
      const result = await this.transactions.run(async (tx) => {
        await tx.$queryRaw`SELECT id FROM messages WHERE id = ${messageId} FOR UPDATE`;
        const current = await tx.message.findUniqueOrThrow({
          where: { id: messageId },
        });
        if (
          current.processingToken !== token ||
          !current.processingUntil ||
          current.processingUntil <= new Date()
        )
          return 'busy' as const;
        if (
          error instanceof TerminalMessageError ||
          current.processingAttempts >= MESSAGE_ATTEMPTS
        ) {
          await this.fail(
            tx,
            messageId,
            error instanceof TerminalMessageError
              ? 'MESSAGE_INVALID'
              : 'MESSAGE_ATTEMPTS_EXHAUSTED',
          );
          return 'terminal' as const;
        }
        const availableAt = new Date(
          Date.now() +
            Math.min(60000, 1000 * 2 ** (current.processingAttempts - 1)),
        );
        await tx.message.update({
          where: { id: messageId },
          data: {
            status: 'RECEIVED',
            processingToken: null,
            processingUntil: null,
            errorCode: 'MESSAGE_PROCESSING_TEMPORARY',
          },
        });
        await tx.messagingOutbox.update({
          where: { messageId },
          data: {
            status: 'PENDING',
            availableAt,
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: 'MESSAGE_PROCESSING_TEMPORARY',
          },
        });
        return 'retry' as const;
      });
      if (result === 'retry') throw new TemporaryMessageError();
      return result;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
  private renew(messageId: string, token: string) {
    const now = new Date();
    return this.prisma.message.updateMany({
      where: {
        id: messageId,
        status: 'PROCESSING',
        processingToken: token,
        processingUntil: { gt: now },
      },
      data: { processingUntil: new Date(now.getTime() + MESSAGE_LEASE_MS) },
    });
  }
  private async fail(
    tx: Prisma.TransactionClient,
    messageId: string,
    code: string,
  ) {
    await tx.message.update({
      where: { id: messageId },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorCode: code,
        errorReason: 'No se pudo procesar el mensaje',
        processingToken: null,
        processingUntil: null,
      },
    });
    await tx.messagingOutbox.update({
      where: { messageId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: code,
      },
    });
    // TODO: MESSAGE_FAILED audit. Never store raw exceptions.
  }
}
