-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lockToken" UUID,
ADD COLUMN     "lockedAt" TIMESTAMPTZ(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3);
