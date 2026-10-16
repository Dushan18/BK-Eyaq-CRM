-- Commit enum additions before CHECK constraints reference them (PostgreSQL).
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'READ';
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'UNKNOWN';
