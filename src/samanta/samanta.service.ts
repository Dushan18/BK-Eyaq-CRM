import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Conversation,
  Prisma,
  SamantaDraft,
} from '../../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { MessagingTransactionService } from '../messaging/messaging-transaction.service';
import { OutboundMessagesService } from '../messaging/outbound-messages.service';
import { SamantaConfig } from './samanta.config';
import { SamantaContextService } from './samanta-context.service';
import {
  PROMPT_VERSION,
  SamantaProvider,
  SamantaProviderError,
  type DraftOutput,
  type TokenUsage,
} from './samanta.provider';
import type {
  EditDraftDto,
  GenerateDraftDto,
  ReviewDraftDto,
} from './samanta.dto';
import {
  activeGeneration,
  latestActivity,
  utcDayStart,
} from './samanta-drafts';

type LockedConversation = Conversation & { latestActivity: number };

@Injectable()
export class SamantaService {
  constructor(
    private readonly transactions: MessagingTransactionService,
    private readonly config: SamantaConfig,
    private readonly provider: SamantaProvider,
    private readonly context: SamantaContextService,
    private readonly outbound: OutboundMessagesService,
  ) {}

  private async conversation(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<LockedConversation> {
    await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${id} FOR UPDATE`;
    const row = await tx.conversation.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Conversación no encontrada');
    return { ...row, latestActivity: await latestActivity(tx, id) };
  }
  private operator(conversation: Conversation, actor: AuthenticatedUser) {
    if (!actor.roles.includes('ADMIN') && !actor.roles.includes('OPERATOR'))
      throw new ForbiddenException();
    if (
      !actor.roles.includes('ADMIN') &&
      conversation.assignedUserId &&
      conversation.assignedUserId !== actor.id
    )
      throw new ForbiddenException('Conversación asignada a otro operador');
  }
  private stale(draft: SamantaDraft, conversation: LockedConversation) {
    return (
      conversation.latestActivity > draft.baselineSequence ||
      conversation.isAssistantPaused ||
      draft.expiresAt <= new Date()
    );
  }
  private async refresh(
    tx: Prisma.TransactionClient,
    draft: SamantaDraft,
    conversation: LockedConversation,
  ) {
    if (
      draft.status === 'GENERATING' &&
      draft.generationExpiresAt &&
      draft.generationExpiresAt <= new Date()
    )
      return tx.samantaDraft.update({
        where: { id: draft.id },
        data: { status: 'FAILED', errorCode: 'AI_GENERATION_EXPIRED' },
      });
    // A generation in progress keeps its slot until it ends; the end decides if
    // the result is stale. Releasing it earlier let more calls than the limit run.
    if (draft.status === 'READY' && this.stale(draft, conversation))
      return tx.samantaDraft.update({
        where: { id: draft.id },
        data: { status: 'STALE' },
      });
    return draft;
  }
  async list(id: string) {
    return this.transactions.run(async (tx) => {
      const conversation = await this.conversation(tx, id);
      const drafts = await tx.samantaDraft.findMany({
        where: { conversationId: id },
        take: 50,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const data: SamantaDraft[] = [];
      for (const draft of drafts)
        data.push(await this.refresh(tx, draft, conversation));
      return { data };
    });
  }
  async get(id: string, draftId: string) {
    return this.transactions.run(async (tx) => {
      const conversation = await this.conversation(tx, id);
      return this.refresh(tx, await this.find(tx, id, draftId), conversation);
    });
  }
  private async find(
    tx: Prisma.TransactionClient,
    id: string,
    draftId: string,
  ) {
    const draft = await tx.samantaDraft.findFirst({
      where: { id: draftId, conversationId: id },
    });
    if (!draft) throw new NotFoundException('Borrador no encontrado');
    return draft;
  }
  async generate(
    id: string,
    actor: AuthenticatedUser,
    key: string | undefined,
    dto: GenerateDraftDto,
  ) {
    this.config.assertEnabled();
    if (!key || !/^[a-zA-Z0-9_-]{16,80}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key inválida (16 a 80 caracteres)',
      );
    const claim = await this.transactions.run(async (tx) => {
      const conversation = await this.conversation(tx, id);
      this.operator(conversation, actor);
      const existing = await tx.samantaDraft.findUnique({
        where: {
          conversationId_idempotencyKey: {
            conversationId: id,
            idempotencyKey: key,
          },
        },
      });
      if (existing) {
        if (
          existing.sourceMessageId !== dto.sourceMessageId ||
          existing.createdById !== actor.id
        )
          throw new ConflictException(
            'Idempotency-Key utilizada con otros datos',
          );
        return {
          draft: await this.refresh(tx, existing, conversation),
          context: null,
        };
      }
      if (conversation.isAssistantPaused)
        throw new ConflictException(
          'Samanta está pausada en esta conversación',
        );
      // Reactions, stickers or audio after the text do not count as newer.
      const source = await tx.message.findFirst({
        where: {
          id: dto.sourceMessageId,
          conversationId: id,
          direction: 'INBOUND',
          type: 'TEXT',
        },
        select: { content: true, sequence: true },
      });
      if (
        !source?.content?.trim() ||
        source.content.length > 4096 ||
        conversation.latestActivity > source.sequence
      )
        throw new ConflictException(
          'Selecciona el último mensaje entrante de texto (máximo 4096 caracteres)',
        );
      // Never pay for a draft that could not be sent: channel off or window closed.
      const maxCharacters = await this.outbound.assertCanReply(tx, id);
      const now = new Date();
      const count = await tx.samantaDraft.count({
        where: { generationStartedAt: { gte: utcDayStart(now) } },
      });
      const active = activeGeneration(now);
      if (
        count >= this.config.dailyLimit ||
        (await tx.samantaDraft.count({ where: active })) >=
          this.config.concurrentLimit
      )
        throw new HttpException(
          'Límite de generación de Samanta alcanzado',
          429,
        );
      if (
        await tx.samantaDraft.count({
          where: { ...active, conversationId: id },
        })
      )
        throw new ConflictException('Ya hay un borrador en generación');
      const context = await this.context.build(tx, id, maxCharacters);
      const draft = await tx.samantaDraft.create({
        data: {
          conversationId: id,
          sourceMessageId: dto.sourceMessageId,
          baselineSequence: source.sequence,
          idempotencyKey: key,
          createdById: actor.id,
          model: this.config.model,
          promptVersion: PROMPT_VERSION,
          knowledgeHash: context.hash,
          generationStartedAt: now,
          generationExpiresAt: new Date(
            now.getTime() + this.config.timeoutMs + 10000,
          ),
          expiresAt: new Date(now.getTime() + this.config.draftTtlMs),
        },
      });
      return { draft, context: context.context };
    }, true);
    if (!claim.context) return claim.draft;
    let output: DraftOutput | undefined;
    let errorCode: string | undefined;
    let usage: TokenUsage | undefined;
    try {
      output = await this.provider.generate(claim.context, 'draft');
    } catch (error) {
      errorCode =
        error instanceof SamantaProviderError ? error.code : 'AI_UNAVAILABLE';
      usage = error instanceof SamantaProviderError ? error.usage : undefined;
    }
    // The external call is deliberately OUTSIDE the retried DB transaction.
    return this.transactions.run(async (tx) => {
      const conversation = await this.conversation(tx, id);
      const current = await this.refresh(
        tx,
        await this.find(tx, id, claim.draft.id),
        conversation,
      );
      // A discarded or failed draft may still have consumed provider tokens.
      const spent = output ?? usage;
      const tokens = spent
        ? { inputTokens: spent.inputTokens, outputTokens: spent.outputTokens }
        : {};
      if (current.status !== 'GENERATING') {
        if (spent && ['STALE', 'FAILED'].includes(current.status))
          return tx.samantaDraft.update({
            where: { id: current.id },
            data: tokens,
          });
        return current;
      }
      if (!output)
        return tx.samantaDraft.update({
          where: { id: current.id },
          data: { status: 'FAILED', errorCode, ...tokens },
        });
      if (this.stale(current, conversation))
        return tx.samantaDraft.update({
          where: { id: current.id },
          data: { status: 'STALE', ...tokens },
        });
      let validKnowledge = false;
      try {
        validKnowledge =
          (await this.context.knowledge(tx)).hash === current.knowledgeHash;
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
      }
      return tx.samantaDraft.update({
        where: { id: current.id },
        data: {
          ...output,
          originalContent: output.content,
          status: validKnowledge ? 'READY' : 'STALE',
        },
      });
    });
  }
  async review(
    id: string,
    draftId: string,
    actor: AuthenticatedUser,
    dto: ReviewDraftDto | EditDraftDto,
    action: 'edit' | 'approve' | 'reject',
  ) {
    if (action !== 'reject') this.config.assertEnabled();
    const result = await this.transactions.run(async (tx) => {
      const conversation = await this.conversation(tx, id);
      this.operator(conversation, actor);
      const draft = await this.refresh(
        tx,
        await this.find(tx, id, draftId),
        conversation,
      );
      if (draft.revision !== dto.revision)
        throw new ConflictException('El borrador cambió; vuelve a revisarlo');
      if (
        action === 'approve' &&
        draft.status === 'APPROVED' &&
        draft.reviewedById === actor.id
      )
        return { draft };
      if (
        action === 'reject' &&
        draft.status === 'REJECTED' &&
        draft.reviewedById === actor.id
      )
        return { draft };
      if (draft.status === 'STALE' || draft.status === 'FAILED')
        return { stale: true as const };
      if (draft.status !== 'READY')
        throw new ConflictException(
          'El borrador no está disponible para revisión',
        );
      if (action !== 'reject') {
        let validKnowledge = false;
        try {
          validKnowledge =
            (await this.context.knowledge(tx)).hash === draft.knowledgeHash;
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
        }
        if (!validKnowledge) {
          await tx.samantaDraft.update({
            where: { id: draft.id },
            data: { status: 'STALE' },
          });
          return { stale: true as const };
        }
      }
      if (action === 'edit') {
        if (
          !('content' in dto) ||
          !dto.content.trim() ||
          dto.content.length > 4096
        )
          throw new BadRequestException('Contenido inválido');
        return {
          draft: await tx.samantaDraft.update({
            where: { id: draft.id },
            data: {
              content: dto.content,
              editedById: actor.id,
              revision: { increment: 1 },
            },
          }),
        };
      }
      const outbound =
        action === 'approve'
          ? await this.outbound.queueOutboundMessage(
              id,
              actor.id,
              `samanta-${draft.id}`,
              { type: 'TEXT', content: draft.content! },
              tx,
            )
          : null;
      return {
        draft: await tx.samantaDraft.update({
          where: { id: draft.id },
          data: {
            status: action === 'approve' ? 'APPROVED' : 'REJECTED',
            reviewedById: actor.id,
            reviewedAt: new Date(),
            outboundMessageId: outbound?.id,
          },
        }),
      };
    }, true);
    if ('stale' in result)
      throw new ConflictException(
        'Borrador desactualizado o fallido; genera uno nuevo',
      );
    return result.draft;
  }
}
