import type { Prisma } from '../../generated/prisma/client';
import { RoleCode } from '../../generated/prisma/enums';

export const conversationSelect = {
  id: true,
  customerId: true,
  channel: true,
  isAssistantPaused: true,
  assignedUserId: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
  customer: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
    },
  },
  assignedUser: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      isActive: true,
      roles: { select: { role: { select: { code: true } } } },
    },
  },
  _count: {
    select: { messages: { where: { direction: 'INBOUND', readAt: null } } },
  },
} satisfies Prisma.ConversationSelect;
type ConversationRow = Prisma.ConversationGetPayload<{
  select: typeof conversationSelect;
}>;
export function conversationResponse(row: ConversationRow) {
  const { _count, assignedUser, ...rest } = row;
  const assigned = assignedUser
    ? {
        id: assignedUser.id,
        firstName: assignedUser.firstName,
        lastName: assignedUser.lastName,
        isActive: assignedUser.isActive,
        isEligible:
          assignedUser.isActive &&
          assignedUser.roles.some(
            ({ role }) =>
              role.code === RoleCode.ADMIN || role.code === RoleCode.OPERATOR,
          ),
      }
    : null;
  return { ...rest, assignedUser: assigned, unreadCount: _count.messages };
}
export const messageSelect = {
  id: true,
  conversationId: true,
  channel: true,
  sequence: true,
  externalMessageId: true,
  direction: true,
  status: true,
  type: true,
  content: true,
  authorUserId: true,
  occurredAt: true,
  receivedAt: true,
  processedAt: true,
  sentAt: true,
  deliveredAt: true,
  providerReadAt: true,
  failedAt: true,
  readAt: true,
  errorCode: true,
  createdAt: true,
  updatedAt: true,
  attachments: {
    select: {
      id: true,
      type: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      externalMediaId: true,
      url: true,
      createdAt: true,
    },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.MessageSelect;
