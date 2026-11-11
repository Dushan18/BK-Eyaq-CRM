-- M9.3: the customer is told the owner's decision (accepted, rejected or change proposed)
-- in Samanta's conversation or, for website requests, by WhatsApp. Each request points to
-- the one notice queued for it, or keeps why none could be sent, for the team.
-- Additive: no existing row changes; both columns start NULL.
ALTER TABLE "reservation_requests" ADD COLUMN "customerNoticeMessageId" TEXT;
ALTER TABLE "reservation_requests" ADD COLUMN "customerNoticeError" VARCHAR(80);
CREATE UNIQUE INDEX "reservation_requests_customerNoticeMessageId_key" ON "reservation_requests"("customerNoticeMessageId");
ALTER TABLE "reservation_requests" ADD CONSTRAINT "reservation_requests_customerNoticeMessageId_fkey" FOREIGN KEY ("customerNoticeMessageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Either a notice or the reason there is none, never both.
ALTER TABLE "reservation_requests" ADD CONSTRAINT "reservation_requests_customer_notice_check" CHECK (
  "customerNoticeMessageId" IS NULL OR "customerNoticeError" IS NULL
);
