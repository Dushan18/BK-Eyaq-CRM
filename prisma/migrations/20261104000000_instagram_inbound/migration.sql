-- Instagram identities are account-scoped IDs, not phone numbers or emails.
-- Existing customers and provider uniqueness constraints are preserved.
ALTER TABLE "customers" DROP CONSTRAINT "customers_contact_check";
ALTER TABLE "customers" ADD CONSTRAINT "customers_contact_check" CHECK (
  "normalizedPhone" IS NOT NULL OR "normalizedEmail" IS NOT NULL OR
  ("sourceChannel" IN ('FACEBOOK', 'INSTAGRAM') AND
   "providerAccountId" IS NOT NULL AND "externalContactId" IS NOT NULL)
);
