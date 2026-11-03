-- Additive: existing phone/email customers and WhatsApp messages are unchanged.
ALTER TABLE "customers" ADD COLUMN "providerAccountId" VARCHAR(80),
  ADD COLUMN "externalContactId" VARCHAR(80);
ALTER TABLE "customers" DROP CONSTRAINT "customers_contact_check";
ALTER TABLE "customers" ADD CONSTRAINT "customers_contact_check" CHECK (
  "normalizedPhone" IS NOT NULL OR "normalizedEmail" IS NOT NULL OR
  ("sourceChannel" = 'FACEBOOK' AND "providerAccountId" IS NOT NULL AND "externalContactId" IS NOT NULL)
);
ALTER TABLE "customers" ADD CONSTRAINT "customers_provider_identity_check" CHECK (
  ("providerAccountId" IS NULL AND "externalContactId" IS NULL) OR
  ("providerAccountId" IS NOT NULL AND "externalContactId" IS NOT NULL AND
   "providerAccountId" ~ '^[0-9]{1,80}$' AND "externalContactId" ~ '^[0-9]{1,80}$')
);
CREATE UNIQUE INDEX "customers_sourceChannel_providerAccountId_externalContactId_key"
  ON "customers"("sourceChannel", "providerAccountId", "externalContactId");
ALTER TABLE "messages" ADD COLUMN "recipientExternalId" VARCHAR(80);
