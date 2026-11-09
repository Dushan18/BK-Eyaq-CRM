import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client';
import { SAMANTA_USER_ID } from '../common/constants/system-users.constants';
import { PrismaService } from '../database/prisma.service';
import {
  AssistantBridge,
  type AssistantHandler,
  type ProcessedMessage,
} from '../messaging/assistant-bridge';
import { MessagingTransactionService } from '../messaging/messaging-transaction.service';
import { messageSelect } from '../messaging/messaging.select';
import {
  OutboundMessagesService,
  SERVICE_WINDOW_MS,
} from '../messaging/outbound-messages.service';
import { SamantaConfig } from './samanta.config';
import { SamantaContextService } from './samanta-context.service';
import {
  PROMPT_VERSION,
  SamantaProvider,
  SamantaProviderError,
  type DraftOutput,
} from './samanta.provider';
import {
  activeGeneration,
  handOff,
  latestActivity,
  utcDayStart,
} from './samanta-drafts';

interface Job {
  id: string;
  conversationId: string;
  context: string;
}

// Automatic mode: each inbound text schedules an AUTO draft (in the transaction
// that marks the message PROCESSED); this worker generates it outside any
// transaction and sends it through the regular outbox, signed by SAMANTA_USER_ID.
@Injectable()
export class SamantaAutoService
  implements AssistantHandler, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SamantaAutoService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: MessagingTransactionService,
    private readonly config: SamantaConfig,
    private readonly provider: SamantaProvider,
    private readonly context: SamantaContextService,
    private readonly outbound: OutboundMessagesService,
    private readonly bridge: AssistantBridge,
    private readonly env: ConfigService,
  ) {}
  get autoReplies() {
    return this.config.autoEnabled;
  }
  onModuleInit() {
    this.bridge.handler = this;
    if (!this.config.autoEnabled) return;
    // Inbound messages are only processed by the messaging workers.
    if (this.env.get<string>('MESSAGING_ENABLED') !== 'true') {
      this.logger.warn(
        JSON.stringify({ code: 'SAMANTA_AUTO_REQUIRES_MESSAGING' }),
      );
      return;
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.bridge.handler === this) this.bridge.handler = undefined;
    await this.running;
  }
  private tick() {
    if (this.running) return;
    this.running = this.runOnce()
      .catch(() => this.logger.warn('SAMANTA_AUTO_UNAVAILABLE'))
      .finally(() => {
        this.running = undefined;
      });
  }

  async inboundProcessed(
    tx: Prisma.TransactionClient,
    message: ProcessedMessage,
  ) {
    if (
      !this.config.autoEnabled ||
      message.direction !== 'INBOUND' ||
      message.type !== 'TEXT'
    )
      return;
    await this.schedule(tx, message, `auto-${message.id}`);
  }

  async assistantResumed(tx: Prisma.TransactionClient, conversationId: string) {
    if (!this.config.autoEnabled) return;
    const latest = await tx.message.findFirst({
      where: { conversationId },
      orderBy: { sequence: 'desc' },
      select: messageSelect,
    });
    // Only an unanswered text still inside the 24-hour window: an older one could not
    // be answered, and a reply that fails would hand the conversation back at once.
    if (
      !latest ||
      latest.direction !== 'INBOUND' ||
      latest.type !== 'TEXT' ||
      latest.status !== 'PROCESSED' ||
      (latest.occurredAt ?? latest.createdAt).getTime() <
        Date.now() - SERVICE_WINDOW_MS
    )
      return;
    // A new key: an earlier reply to this message may exist (stale while paused).
    await this.schedule(
      tx,
      latest,
      `auto-${latest.id}-r${Date.now().toString(36)}`,
    );
  }

  private async schedule(
    tx: Prisma.TransactionClient,
    message: ProcessedMessage,
    idempotencyKey: string,
  ) {
    const { conversationId } = message;
    await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { channel: true, isAssistantPaused: true },
    });
    if (
      conversation.isAssistantPaused ||
      !this.config.autoChannels.includes(conversation.channel)
    )
      return;
    // Workers may process out of order: a newer text schedules its own reply.
    const newer = await tx.message.count({
      where: {
        conversationId,
        direction: 'INBOUND',
        type: 'TEXT',
        sequence: { gt: message.sequence },
      },
    });
    if (newer) return;
    const now = new Date();
    // One reply for a burst of messages: the newest text answers the earlier ones.
    await tx.samantaDraft.updateMany({
      where: { conversationId, mode: 'AUTO', status: 'SCHEDULED' },
      data: { status: 'STALE' },
    });
    await tx.samantaDraft.createMany({
      data: [
        {
          conversationId,
          sourceMessageId: message.id,
          baselineSequence: message.sequence,
          idempotencyKey,
          createdById: SAMANTA_USER_ID,
          mode: 'AUTO',
          status: 'SCHEDULED',
          model: this.config.model,
          promptVersion: PROMPT_VERSION,
          knowledgeHash: '',
          availableAt: new Date(now.getTime() + this.config.autoDelayMs),
          expiresAt: new Date(now.getTime() + this.config.draftTtlMs),
        },
      ],
      skipDuplicates: true,
    });
  }

  async runOnce() {
    if (!this.config.autoEnabled) return;
    await this.expireAbandoned();
    const due = await this.prisma.samantaDraft.findMany({
      where: {
        mode: 'AUTO',
        status: 'SCHEDULED',
        availableAt: { lte: new Date() },
      },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: 20,
      select: { id: true },
    });
    const jobs: Job[] = [];
    for (const { id } of due) {
      const job = await this.claim(id).catch(async () => {
        this.logger.warn(
          JSON.stringify({ code: 'SAMANTA_AUTO_CLAIM_FAILED', draftId: id }),
        );
        await this.fail(id, 'AUTO_INTERNAL_ERROR');
        return null;
      });
      if (job) jobs.push(job);
    }
    await Promise.all(jobs.map((job) => this.answer(job)));
  }

  // A worker that died mid-call leaves GENERATING drafts behind: the customer still
  // needs an answer, so a person takes over.
  private async expireAbandoned() {
    const expired = await this.prisma.samantaDraft.findMany({
      where: {
        mode: 'AUTO',
        status: 'GENERATING',
        generationExpiresAt: { lte: new Date() },
      },
      take: 20,
      select: { id: true },
    });
    for (const { id } of expired) await this.fail(id, 'AI_GENERATION_EXPIRED');
  }
  private fail(id: string, errorCode: string) {
    return this.transactions.run(async (tx) => {
      const draft = await tx.samantaDraft.findUnique({ where: { id } });
      if (!draft || !['SCHEDULED', 'GENERATING'].includes(draft.status)) return;
      await tx.samantaDraft.update({
        where: { id },
        data: { status: 'FAILED', errorCode },
      });
      await handOff(tx, draft.conversationId);
    });
  }

  private claim(id: string): Promise<Job | null> {
    return this.transactions.run(async (tx) => {
      const draft = await tx.samantaDraft.findUnique({ where: { id } });
      if (!draft || draft.status !== 'SCHEDULED') return null;
      const { conversationId } = draft;
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { channel: true, isAssistantPaused: true },
      });
      const now = new Date();
      const close = async (
        data: Prisma.SamantaDraftUncheckedUpdateInput,
        transfer = false,
      ) => {
        await tx.samantaDraft.update({ where: { id }, data });
        if (transfer) await handOff(tx, conversationId);
        return null;
      };
      // Paused, channel turned off, or a person already answered after the message.
      if (
        conversation.isAssistantPaused ||
        !this.config.autoChannels.includes(conversation.channel) ||
        (await latestActivity(tx, conversationId)) > draft.baselineSequence
      )
        return close({ status: 'STALE' });
      if (draft.expiresAt <= now)
        return close({ status: 'FAILED', errorCode: 'AUTO_EXPIRED' }, true);
      // Busy: try again on a later tick.
      if (
        (await tx.samantaDraft.count({
          where: { conversationId, ...activeGeneration(now) },
        })) ||
        (await tx.samantaDraft.count({ where: activeGeneration(now) })) >=
          this.config.concurrentLimit
      )
        return null;
      if (
        (await tx.samantaDraft.count({
          where: { generationStartedAt: { gte: utcDayStart(now) } },
        })) >= this.config.dailyLimit
      )
        return close({ status: 'FAILED', errorCode: 'AUTO_DAILY_LIMIT' }, true);
      // Guards against loops and spam in a single conversation.
      if (
        (await tx.samantaDraft.count({
          where: {
            conversationId,
            mode: 'AUTO',
            generationStartedAt: { gte: new Date(now.getTime() - 3600000) },
          },
        })) >= this.config.autoMaxPerHour
      )
        return close(
          { status: 'FAILED', errorCode: 'AUTO_CONVERSATION_LIMIT' },
          true,
        );
      let maxCharacters: number;
      try {
        maxCharacters = await this.outbound.assertCanReply(tx, conversationId);
      } catch (error) {
        // Only reads ran before the check failed, so the transaction is still usable.
        if (!(error instanceof HttpException)) throw error;
        return close({ status: 'FAILED', errorCode: 'AUTO_CANNOT_REPLY' });
      }
      let context: { context: string; hash: string };
      try {
        context = await this.context.build(tx, conversationId, maxCharacters);
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        return close(
          { status: 'FAILED', errorCode: 'AI_CONTEXT_UNAVAILABLE' },
          true,
        );
      }
      await tx.samantaDraft.update({
        where: { id },
        data: {
          status: 'GENERATING',
          model: this.config.model,
          promptVersion: PROMPT_VERSION,
          knowledgeHash: context.hash,
          generationStartedAt: now,
          generationExpiresAt: new Date(
            now.getTime() + this.config.timeoutMs + 10000,
          ),
        },
      });
      return { id, conversationId, context: context.context };
    });
  }

  private async answer(job: Job) {
    let output: DraftOutput | undefined;
    let failure: SamantaProviderError | undefined;
    // The external call is deliberately OUTSIDE the retried DB transaction.
    try {
      output = await this.provider.generate(job.context, 'auto');
    } catch (error) {
      failure =
        error instanceof SamantaProviderError
          ? error
          : new SamantaProviderError('AI_UNAVAILABLE');
    }
    try {
      const draft = await this.transactions.run((tx) =>
        this.finish(tx, job, output, failure),
      );
      this.logger.log(
        JSON.stringify({
          code: 'SAMANTA_AUTO_REPLY',
          draftId: job.id,
          status: draft.status,
          errorCode: draft.errorCode,
          intent: draft.intent,
          requiresHuman: draft.requiresHuman,
          inputTokens: draft.inputTokens,
          outputTokens: draft.outputTokens,
        }),
      );
    } catch {
      // The draft stays GENERATING; expireAbandoned hands it to a person later.
      this.logger.warn(
        JSON.stringify({ code: 'SAMANTA_AUTO_FINISH_FAILED', draftId: job.id }),
      );
    }
  }

  private async finish(
    tx: Prisma.TransactionClient,
    job: Job,
    output: DraftOutput | undefined,
    failure: SamantaProviderError | undefined,
  ) {
    const { id, conversationId } = job;
    await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { isAssistantPaused: true },
    });
    const draft = await tx.samantaDraft.findUniqueOrThrow({ where: { id } });
    const spent = output ?? failure?.usage;
    const tokens = spent
      ? { inputTokens: spent.inputTokens, outputTokens: spent.outputTokens }
      : {};
    const update = (data: Prisma.SamantaDraftUncheckedUpdateInput) =>
      tx.samantaDraft.update({ where: { id }, data: { ...tokens, ...data } });
    // Already closed (expired while waiting): only record what was charged.
    if (draft.status !== 'GENERATING') return update({});
    if (!output) {
      await handOff(tx, conversationId);
      return update({
        status: 'FAILED',
        errorCode: failure?.code ?? 'AI_UNAVAILABLE',
      });
    }
    // The customer wrote again, or a person stepped in: the newer message gets
    // its own reply; this one is discarded.
    if (
      conversation.isAssistantPaused ||
      (await latestActivity(tx, conversationId)) > draft.baselineSequence
    )
      return update({ status: 'STALE' });
    const content = { ...output, originalContent: output.content };
    // Shadow mode: nothing reaches the customer; the team reviews the draft.
    if (!this.config.autoSend) return update({ ...content, status: 'READY' });
    try {
      const message = await this.outbound.queueOutboundMessage(
        conversationId,
        SAMANTA_USER_ID,
        `samanta-auto-${id}`,
        { type: 'TEXT', content: output.content },
        tx,
      );
      if (output.requiresHuman) await handOff(tx, conversationId);
      return update({
        ...content,
        status: 'APPROVED',
        reviewedById: SAMANTA_USER_ID,
        reviewedAt: new Date(),
        outboundMessageId: message.id,
      });
    } catch (error) {
      // Channel limits or a window that closed meanwhile: a person answers instead.
      if (!(error instanceof HttpException)) throw error;
      await handOff(tx, conversationId);
      return update({
        ...content,
        status: 'FAILED',
        errorCode: 'AUTO_SEND_REJECTED',
      });
    }
  }
}
