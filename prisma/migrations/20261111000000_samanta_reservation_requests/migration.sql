-- M8.2: in automatic mode Samanta registers a reservation request once the customer
-- confirms a summary she sent. The summary's validated data stays on its draft, and the
-- request created from it points back to that draft (unique: one request per summary).
-- Additive: no existing row changes.
ALTER TABLE "samanta_drafts" ADD COLUMN "reservationOutcome" VARCHAR(40),
ADD COLUMN "reservationProposal" JSONB,
ADD COLUMN "reservationRequestId" TEXT;

CREATE UNIQUE INDEX "samanta_drafts_reservationRequestId_key" ON "samanta_drafts"("reservationRequestId");
ALTER TABLE "samanta_drafts" ADD CONSTRAINT "samanta_drafts_reservationRequestId_fkey" FOREIGN KEY ("reservationRequestId") REFERENCES "reservation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only a summary can produce a request.
ALTER TABLE "samanta_drafts" ADD CONSTRAINT "samanta_drafts_reservation_request_check" CHECK ("reservationRequestId" IS NULL OR "reservationProposal" IS NOT NULL);
