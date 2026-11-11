-- M8, first part: a reservation request can point to the conversation it belongs to, and
-- every status change is recorded with who made it.
-- Additive: no existing row changes. Existing requests (website emails included) keep
-- conversationId NULL and start with an empty history.
CREATE TYPE "ReservationRequestActorType" AS ENUM ('USER', 'SAMANTA', 'OWNER', 'SYSTEM');

ALTER TABLE "reservation_requests" ADD COLUMN "conversationId" TEXT;
CREATE INDEX "reservation_requests_conversationId_idx" ON "reservation_requests"("conversationId");
ALTER TABLE "reservation_requests" ADD CONSTRAINT "reservation_requests_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "reservation_request_status_history" (
    "id" TEXT NOT NULL,
    "reservationRequestId" TEXT NOT NULL,
    "previousStatus" "ReservationRequestStatus" NOT NULL,
    "newStatus" "ReservationRequestStatus" NOT NULL,
    "actorType" "ReservationRequestActorType" NOT NULL,
    "actorId" TEXT,
    "reason" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_request_status_history_pkey" PRIMARY KEY ("id"),
    -- Only real changes: an update that keeps the status never writes a row.
    CONSTRAINT "reservation_request_status_history_change_check" CHECK ("previousStatus" <> "newStatus"),
    -- A user, Samanta or the owner is always identified; SYSTEM may have no actor.
    CONSTRAINT "reservation_request_status_history_actor_check" CHECK ("actorType" = 'SYSTEM' OR "actorId" IS NOT NULL)
);

CREATE INDEX "reservation_request_status_history_reservationRequestId_cre_idx" ON "reservation_request_status_history"("reservationRequestId", "createdAt", "id");
CREATE INDEX "reservation_request_status_history_actorId_idx" ON "reservation_request_status_history"("actorId");
ALTER TABLE "reservation_request_status_history" ADD CONSTRAINT "reservation_request_status_history_reservationRequestId_fkey" FOREIGN KEY ("reservationRequestId") REFERENCES "reservation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservation_request_status_history" ADD CONSTRAINT "reservation_request_status_history_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
