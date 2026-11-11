import type { Prisma } from '../../generated/prisma/client';
import {
  ReservationRequestActorType,
  type ReservationRequestStatus,
} from '../../generated/prisma/enums';

export interface RequestStatusActor {
  type: ReservationRequestActorType;
  // The acting user: required for USER, SAMANTA (SAMANTA_USER_ID) and OWNER; none for SYSTEM.
  id?: string | null;
}
export interface RequestStatusChange {
  requestId: string;
  previousStatus: ReservationRequestStatus;
  newStatus: ReservationRequestStatus;
  actor: RequestStatusActor;
  reason?: string | null;
}

export const userActor = (user: { id: string }): RequestStatusActor => ({
  type: ReservationRequestActorType.USER,
  id: user.id,
});

// Every write that may change a request's status calls this in the same transaction,
// with the status it read in that transaction: the new status and its history row commit
// together or not at all. An unchanged status writes nothing, so a retry or an edit of
// other fields never adds a row. Returns whether a row was written.
export async function recordRequestStatusChange(
  tx: Prisma.TransactionClient,
  change: RequestStatusChange,
): Promise<boolean> {
  if (change.previousStatus === change.newStatus) return false;
  const actorId = change.actor.id ?? null;
  if (change.actor.type !== ReservationRequestActorType.SYSTEM && !actorId)
    throw new Error(
      `Falta el actor del cambio de estado (${change.actor.type})`,
    );
  await tx.reservationRequestStatusHistory.create({
    data: {
      reservationRequestId: change.requestId,
      previousStatus: change.previousStatus,
      newStatus: change.newStatus,
      actorType: change.actor.type,
      actorId,
      reason: change.reason ?? null,
    },
    select: { id: true },
  });
  return true;
}
