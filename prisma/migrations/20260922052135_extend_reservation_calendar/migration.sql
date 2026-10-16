-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "assignedUserId" TEXT;

-- CreateTable
CREATE TABLE "reservation_notes" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "content" VARCHAR(5000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_reschedule_history" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "previousReservationAt" TIMESTAMPTZ(3) NOT NULL,
    "newReservationAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" VARCHAR(5000),
    "changedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_reschedule_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservation_notes_reservationId_createdAt_id_idx" ON "reservation_notes"("reservationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "reservation_notes_authorUserId_idx" ON "reservation_notes"("authorUserId");

-- CreateIndex
CREATE INDEX "reservation_reschedule_history_reservationId_createdAt_id_idx" ON "reservation_reschedule_history"("reservationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "reservation_reschedule_history_changedByUserId_idx" ON "reservation_reschedule_history"("changedByUserId");

-- CreateIndex
CREATE INDEX "reservations_assignedUserId_reservationAt_idx" ON "reservations"("assignedUserId", "reservationAt");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_notes" ADD CONSTRAINT "reservation_notes_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_notes" ADD CONSTRAINT "reservation_notes_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_reschedule_history" ADD CONSTRAINT "reservation_reschedule_history_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_reschedule_history" ADD CONSTRAINT "reservation_reschedule_history_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservation_notes" ADD CONSTRAINT "reservation_notes_content_check" CHECK (length(btrim("content")) > 0);
ALTER TABLE "reservation_reschedule_history" ADD CONSTRAINT "reservation_reschedule_dates_check" CHECK ("previousReservationAt" <> "newReservationAt");
