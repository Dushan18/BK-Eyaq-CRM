-- M9.1: requests from Samanta and the website are sent to the owner's personal WhatsApp
-- for approval. The owner's number lives in the restaurant configuration, and each request
-- points to the one template message that asked the owner (unique: never sent twice).
-- Additive: no existing row changes; both columns start NULL.
ALTER TABLE "restaurant_configs" ADD COLUMN "ownerWhatsappNumber" VARCHAR(16);
ALTER TABLE "restaurant_configs" ADD CONSTRAINT "restaurant_configs_owner_whatsapp_check" CHECK (
  "ownerWhatsappNumber" IS NULL OR (
    "ownerWhatsappNumber" ~ '^\+[1-9][0-9]{7,14}$' AND "ownerWhatsappNumber" <> "whatsappNumber"
  )
);

ALTER TABLE "reservation_requests" ADD COLUMN "ownerMessageId" TEXT;
CREATE UNIQUE INDEX "reservation_requests_ownerMessageId_key" ON "reservation_requests"("ownerMessageId");
ALTER TABLE "reservation_requests" ADD CONSTRAINT "reservation_requests_ownerMessageId_fkey" FOREIGN KEY ("ownerMessageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Waiting for the owner always means a notification exists.
ALTER TABLE "reservation_requests" ADD CONSTRAINT "reservation_requests_owner_message_check" CHECK (
  "status" NOT IN ('SENT_TO_OWNER', 'WAITING_RESPONSE') OR "ownerMessageId" IS NOT NULL
);
