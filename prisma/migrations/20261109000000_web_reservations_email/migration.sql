-- Website reservations: the restaurant mailbox is read over IMAP (read-only) and each
-- "Nueva reserva SM-..." notification becomes a customer and a reservation request, and the
-- customer is contacted by WhatsApp (a template when the 24-hour window is closed).
-- Additive: no existing row changes.
CREATE TYPE "InboundEmailKind" AS ENUM ('WEB_RESERVATION');
CREATE TYPE "InboundEmailStatus" AS ENUM ('IMPORTED', 'SKIPPED', 'FAILED');

-- A WhatsApp template message. `content` keeps the CRM's rendering for the history.
ALTER TABLE "messages" ADD COLUMN "templateLanguage" VARCHAR(15),
  ADD COLUMN "templateName" VARCHAR(512),
  ADD COLUMN "templateParameters" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "messages" ADD CONSTRAINT "message_template_valid" CHECK (
  ("templateName" IS NULL) = ("templateLanguage" IS NULL) AND
  ("templateName" IS NULL OR ("direction" = 'OUTBOUND' AND length(btrim("templateName")) > 0))
);

-- The website's own code ("SM-20261029-B65A25"): unique, so a resent email never
-- creates a second request.
ALTER TABLE "reservation_requests" ADD COLUMN "externalReference" VARCHAR(40);
CREATE UNIQUE INDEX "reservation_requests_externalReference_key" ON "reservation_requests"("externalReference");

-- Outcome of each reservation email read: references only, never the raw email.
CREATE TABLE "inbound_emails" (
  "id" TEXT NOT NULL,
  "mailbox" VARCHAR(320) NOT NULL,
  "uidValidity" BIGINT NOT NULL,
  "uid" BIGINT NOT NULL,
  "messageId" VARCHAR(998),
  "fromAddress" VARCHAR(320),
  "subject" VARCHAR(998),
  "sentAt" TIMESTAMPTZ(3),
  "receivedAt" TIMESTAMPTZ(3),
  "kind" "InboundEmailKind" NOT NULL,
  "status" "InboundEmailStatus" NOT NULL,
  "errorCode" VARCHAR(80),
  "externalReference" VARCHAR(40),
  "customerId" TEXT,
  "reservationRequestId" TEXT,
  "whatsappMessageId" TEXT,
  "contactError" VARCHAR(80),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbound_emails_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbound_emails_uid_check" CHECK ("uidValidity" > 0 AND "uid" > 0),
  CONSTRAINT "inbound_emails_outcome_check" CHECK (
    ("status" <> 'IMPORTED' OR ("customerId" IS NOT NULL AND "reservationRequestId" IS NOT NULL)) AND
    ("status" = 'IMPORTED' OR "errorCode" IS NOT NULL) AND
    ("whatsappMessageId" IS NULL OR "status" = 'IMPORTED')
  )
);
CREATE UNIQUE INDEX "inbound_emails_mailbox_uidValidity_uid_key" ON "inbound_emails"("mailbox", "uidValidity", "uid");
CREATE UNIQUE INDEX "inbound_emails_whatsappMessageId_key" ON "inbound_emails"("whatsappMessageId");
CREATE INDEX "inbound_emails_externalReference_idx" ON "inbound_emails"("externalReference");
CREATE INDEX "inbound_emails_createdAt_idx" ON "inbound_emails"("createdAt");
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_reservationRequestId_fkey" FOREIGN KEY ("reservationRequestId") REFERENCES "reservation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_whatsappMessageId_fkey" FOREIGN KEY ("whatsappMessageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Last UID imported per mailbox; a different UIDVALIDITY restarts the sync from a date.
CREATE TABLE "mailbox_cursors" (
  "mailbox" VARCHAR(320) NOT NULL,
  "uidValidity" BIGINT NOT NULL,
  "lastUid" BIGINT NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "mailbox_cursors_pkey" PRIMARY KEY ("mailbox"),
  CONSTRAINT "mailbox_cursors_uid_check" CHECK ("uidValidity" > 0 AND "lastUid" >= 0)
);
