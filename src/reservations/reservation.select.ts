import type { Prisma } from '../../generated/prisma/client';

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
  customerId: true,
  commercialItemId: true,
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

export const reservationSelect = {
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
