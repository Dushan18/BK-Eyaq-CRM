-- WhatsApp identity: Meta may omit the phone number of users with a username, but always
-- sends their business-scoped user ID (BSUID). Additive: existing rows are unchanged.
ALTER TABLE "customers" ADD COLUMN "whatsappUserId" VARCHAR(160),
  ADD COLUMN "whatsappUsername" VARCHAR(40),
  ADD COLUMN "whatsappProfileName" VARCHAR(100);
CREATE UNIQUE INDEX "customers_whatsappUserId_key" ON "customers"("whatsappUserId");
-- A WhatsApp customer may be known only by its BSUID.
ALTER TABLE "customers" DROP CONSTRAINT "customers_contact_check";
ALTER TABLE "customers" ADD CONSTRAINT "customers_contact_check" CHECK (
  "normalizedPhone" IS NOT NULL OR "normalizedEmail" IS NOT NULL OR
  "whatsappUserId" IS NOT NULL OR
  ("sourceChannel" IN ('FACEBOOK', 'INSTAGRAM') AND
   "providerAccountId" IS NOT NULL AND "externalContactId" IS NOT NULL)
);
-- Messages address a WhatsApp customer by BSUID when there is no phone (up to 128
-- characters plus the country prefix).
ALTER TABLE "messages" ALTER COLUMN "recipientExternalId" TYPE VARCHAR(160);
