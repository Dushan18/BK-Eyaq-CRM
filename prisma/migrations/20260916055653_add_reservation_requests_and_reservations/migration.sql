-- CreateEnum
-- Secuencias globales: permiten huecos y no se reinician anualmente.
CREATE SEQUENCE "reservation_request_code_seq" AS BIGINT NO CYCLE;
CREATE SEQUENCE "reservation_code_seq" AS BIGINT NO CYCLE;

CREATE TYPE "ReservationRequestStatus" AS ENUM ('INCOMPLETE_DATA', 'READY_TO_SEND', 'SENT_TO_OWNER', 'WAITING_RESPONSE', 'ACCEPTED', 'REJECTED', 'MODIFICATION_REQUESTED', 'RENEGOTIATING', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('CONFIRMED', 'UPCOMING', 'IN_SERVICE', 'COMPLETED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "reservation_requests" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "customerId" TEXT NOT NULL,
    "commercialItemId" TEXT,
    "sourceChannel" "ContactChannel" NOT NULL,
    "reservationAt" TIMESTAMPTZ(3),
    "numberOfPeople" INTEGER,
    "quotedPrice" DECIMAL(10,2),
    "currency" "CurrencyCode",
    "comments" TEXT,
    "specialRequirements" TEXT,
    "status" "ReservationRequestStatus" NOT NULL DEFAULT 'INCOMPLETE_DATA',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "reservationRequestId" TEXT,
    "customerId" TEXT NOT NULL,
    "commercialItemId" TEXT,
    "reservationAt" TIMESTAMPTZ(3) NOT NULL,
    "numberOfPeople" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_requests_code_key" ON "reservation_requests"("code");

-- CreateIndex
CREATE INDEX "reservation_requests_createdAt_id_idx" ON "reservation_requests"("createdAt", "id");

-- CreateIndex
CREATE INDEX "reservation_requests_status_createdAt_idx" ON "reservation_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "reservation_requests_customerId_idx" ON "reservation_requests"("customerId");

-- CreateIndex
CREATE INDEX "reservation_requests_commercialItemId_idx" ON "reservation_requests"("commercialItemId");

-- CreateIndex
CREATE INDEX "reservation_requests_sourceChannel_idx" ON "reservation_requests"("sourceChannel");

-- CreateIndex
CREATE INDEX "reservation_requests_reservationAt_idx" ON "reservation_requests"("reservationAt");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_code_key" ON "reservations"("code");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_reservationRequestId_key" ON "reservations"("reservationRequestId");

-- CreateIndex
CREATE INDEX "reservations_reservationAt_id_idx" ON "reservations"("reservationAt", "id");

-- CreateIndex
CREATE INDEX "reservations_status_reservationAt_idx" ON "reservations"("status", "reservationAt");

-- CreateIndex
CREATE INDEX "reservations_customerId_idx" ON "reservations"("customerId");

-- CreateIndex
CREATE INDEX "reservations_commercialItemId_idx" ON "reservations"("commercialItemId");

-- AddForeignKey
ALTER TABLE "reservation_requests" ADD CONSTRAINT "reservation_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_requests" ADD CONSTRAINT "reservation_requests_commercialItemId_fkey" FOREIGN KEY ("commercialItemId") REFERENCES "commercial_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_reservationRequestId_fkey" FOREIGN KEY ("reservationRequestId") REFERENCES "reservation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_commercialItemId_fkey" FOREIGN KEY ("commercialItemId") REFERENCES "commercial_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservation_requests"
  ADD CONSTRAINT "reservation_requests_people_check" CHECK ("numberOfPeople" IS NULL OR "numberOfPeople" >= 1),
  ADD CONSTRAINT "reservation_requests_price_check" CHECK ("quotedPrice" IS NULL OR "quotedPrice" >= 0),
  ADD CONSTRAINT "reservation_requests_currency_check" CHECK (("quotedPrice" IS NULL) = ("currency" IS NULL)),
  ADD CONSTRAINT "reservation_requests_ready_check" CHECK ("status" <> 'READY_TO_SEND' OR ("reservationAt" IS NOT NULL AND "numberOfPeople" IS NOT NULL)),
  ADD CONSTRAINT "reservation_requests_incomplete_check" CHECK ("status" <> 'INCOMPLETE_DATA' OR "reservationAt" IS NULL OR "numberOfPeople" IS NULL);

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_people_check" CHECK ("numberOfPeople" >= 1);
