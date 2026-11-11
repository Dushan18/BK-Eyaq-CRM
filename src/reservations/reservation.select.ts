import type { Prisma } from '../../generated/prisma/client';
import { RoleCode } from '../../generated/prisma/enums';

const publicUser = {
  id: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;
const assigneeSelect = {
  ...publicUser,
  isActive: true,
  roles: { select: { role: { select: { code: true } } } },
} satisfies Prisma.UserSelect;

const customer = {
  select: {
    id: true,
    firstName: true,
    lastName: true,
    phone: true,
    email: true,
  },
} satisfies Prisma.CustomerDefaultArgs;
const commercialItem = {
  select: {
    id: true,
    nameEs: true,
    nameEn: true,
    type: true,
    isActive: true,
    approvalStatus: true,
  },
} satisfies Prisma.CommercialItemDefaultArgs;

export const reservationRequestSelect = {
  id: true,
  code: true,
  // The source's own code, e.g. the website's "SM-20261029-B65A25"; null otherwise.
  externalReference: true,
  customerId: true,
  commercialItemId: true,
  conversationId: true,
  sourceChannel: true,
  reservationAt: true,
  numberOfPeople: true,
  quotedPrice: true,
  currency: true,
  comments: true,
  specialRequirements: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  customer,
  commercialItem,
} satisfies Prisma.ReservationRequestSelect;

// GET /reservation-requests/:id: the request plus its status changes, oldest first.
export const reservationRequestDetailSelect = {
  ...reservationRequestSelect,
  statusHistory: {
    select: {
      id: true,
      previousStatus: true,
      newStatus: true,
      actorType: true,
      actorId: true,
      reason: true,
      createdAt: true,
      actor: { select: publicUser },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  // The calendar reservation created when the request was approved, or null.
  reservation: {
    select: { id: true, code: true, status: true, reservationAt: true },
  },
  // M9.1: the WhatsApp template that asked the owner, with its delivery state, or null.
  ownerMessage: {
    select: {
      id: true,
      status: true,
      errorCode: true,
      createdAt: true,
      sentAt: true,
      deliveredAt: true,
      providerReadAt: true,
    },
  },
  // M9.3: the message that told the customer the owner's decision, with its delivery
  // state, or null; customerNoticeError says why none could be sent.
  customerNoticeMessage: {
    select: {
      id: true,
      conversationId: true,
      channel: true,
      templateName: true,
      status: true,
      errorCode: true,
      createdAt: true,
      sentAt: true,
      deliveredAt: true,
      providerReadAt: true,
    },
  },
  customerNoticeError: true,
} satisfies Prisma.ReservationRequestSelect;

export const reservationSelect = {
  assignedUserId: true,
  assignedUser: { select: assigneeSelect },
  id: true,
  code: true,
  reservationRequestId: true,
  customerId: true,
  commercialItemId: true,
  reservationAt: true,
  numberOfPeople: true,
  status: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  customer,
  commercialItem,
} satisfies Prisma.ReservationSelect;

export const reservationNoteSelect = {
  id: true,
  reservationId: true,
  authorUserId: true,
  content: true,
  createdAt: true,
  author: { select: publicUser },
} satisfies Prisma.ReservationNoteSelect;

export const reservationDetailSelect = {
  ...reservationSelect,
  noteHistory: {
    select: reservationNoteSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  rescheduleHistory: {
    select: {
      id: true,
      previousReservationAt: true,
      newReservationAt: true,
      reason: true,
      changedByUserId: true,
      createdAt: true,
      changedBy: { select: publicUser },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.ReservationSelect;

type AssignedUser = Prisma.UserGetPayload<{ select: typeof assigneeSelect }>;
export function reservationResponse<
  T extends { assignedUser: AssignedUser | null },
>(row: T) {
  const user = row.assignedUser;
  return {
    ...row,
    assignedUser: user
      ? {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          isActive: user.isActive,
          isEligible:
            user.isActive &&
            user.roles.some(
              ({ role }) =>
                role.code === RoleCode.ADMIN || role.code === RoleCode.OPERATOR,
            ),
        }
      : null,
  };
}
