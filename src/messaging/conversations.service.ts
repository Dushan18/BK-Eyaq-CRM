import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { RoleCode } from '../../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  type AssignConversationDto,
  type ConversationMessagesQueryDto,
  type ConversationQueryDto,
  type MarkConversationReadDto,
  type UpdateAssistantPauseDto,
} from './messaging.dto';
import {
  conversationResponse,
  conversationSelect,
  messageSelect,
} from './messaging.select';
import { MessagingTransactionService } from './messaging-transaction.service';

const pagination = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
});
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: MessagingTransactionService,
  ) {}
  async findAll(query: ConversationQueryDto) {
    const digits = query.search?.replace(/\D/g, '');
    const where: Prisma.ConversationWhereInput = {
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.assignedUserId ? { assignedUserId: query.assignedUserId } : {}),
      ...(query.isAssistantPaused !== undefined
        ? { isAssistantPaused: query.isAssistantPaused }
        : {}),
      ...(query.unreadOnly === true
        ? { messages: { some: { direction: 'INBOUND', readAt: null } } }
        : {}),
      ...(query.search
        ? {
            customer: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
                { phone: { contains: query.search } },
                { email: { contains: query.search, mode: 'insensitive' } },
                ...(digits ? [{ normalizedPhone: { contains: digits } }] : []),
              ],
            },
          }
        : {}),
    };
    const { page, limit } = query;
    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.conversation.findMany({
          where,
          select: conversationSelect,
          orderBy: [
            { lastMessageAt: { sort: 'desc', nulls: 'last' } },
            { id: 'desc' },
          ],
          take: limit,
          skip: (page - 1) * limit,
        }),
        this.prisma.conversation.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      data: rows.map(conversationResponse),
      pagination: pagination(page, limit, total),
    };
  }
  async findOne(id: string) {
    const row = await this.prisma.conversation.findUnique({
      where: { id },
      select: conversationSelect,
    });
    if (!row) throw new NotFoundException('Conversación no encontrada');
    return conversationResponse(row);
  }
  async messages(id: string, { page, limit }: ConversationMessagesQueryDto) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.requireConversation(tx, id);
        const where = { conversationId: id };
        const data = await tx.message.findMany({
          where,
          select: messageSelect,
          orderBy: { sequence: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        });
        const total = await tx.message.count({ where });
        return { data, pagination: pagination(page, limit, total) };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async markRead(id: string, dto: MarkConversationReadDto) {
    return this.transactions.run(async (tx) => {
      await this.lockConversation(tx, id);
      const cutoff = await tx.message.findFirst({
        where: { id: dto.throughMessageId, conversationId: id },
        select: { sequence: true },
      });
      if (!cutoff)
        throw new NotFoundException(
          'Mensaje no encontrado en esta conversación',
        );
      const result = await tx.message.updateMany({
        where: {
          conversationId: id,
          direction: 'INBOUND',
          readAt: null,
          sequence: { lte: cutoff.sequence },
        },
        data: { readAt: new Date() },
      });
      return { updated: result.count, throughMessageId: dto.throughMessageId };
    });
  }
  async assistant(id: string, dto: UpdateAssistantPauseDto) {
    return this.transactions.run(async (tx) => {
      await this.requireConversation(tx, id);
      const row = await tx.conversation.update({
        where: { id },
        data: { isAssistantPaused: dto.paused },
        select: conversationSelect,
      });
      // TODO: ASSISTANT_PAUSED / ASSISTANT_RESUMED audit.
      return conversationResponse(row);
    });
  }
  async assign(
    id: string,
    dto: AssignConversationDto,
    actor: AuthenticatedUser,
  ) {
    return this.transactions.run(async (tx) => {
      const current = await this.lockConversation(tx, id);
      if (!actor.roles.includes(RoleCode.ADMIN)) {
        if (
          !actor.roles.includes(RoleCode.OPERATOR) ||
          (dto.assignedUserId !== null && dto.assignedUserId !== actor.id) ||
          (current.assignedUserId !== null &&
            current.assignedUserId !== actor.id)
        ) {
          throw new ForbiddenException(
            'Solo puedes tomar conversaciones libres o desasignarte de las propias',
          );
        }
      }
      if (dto.assignedUserId !== null) {
        const user = await tx.user.findUnique({
          where: { id: dto.assignedUserId },
          select: {
            isActive: true,
            roles: { select: { role: { select: { code: true } } } },
          },
        });
        if (!user) throw new NotFoundException('Usuario no encontrado');
        if (
          !user.isActive ||
          !user.roles.some(
            ({ role }) => role.code === 'ADMIN' || role.code === 'OPERATOR',
          )
        )
          throw new BadRequestException('Responsable no elegible');
      }
      const row = await tx.conversation.update({
        where: { id },
        data: { assignedUserId: dto.assignedUserId },
        select: conversationSelect,
      });
      // TODO: CONVERSATION_ASSIGNED audit.
      return conversationResponse(row);
    });
  }
  private async requireConversation(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.conversation.findUnique({
      where: { id },
      select: { id: true, assignedUserId: true },
    });
    if (!row) throw new NotFoundException('Conversación no encontrada');
    return row;
  }
  private async lockConversation(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${id} FOR UPDATE`;
    return this.requireConversation(tx, id);
  }
}
