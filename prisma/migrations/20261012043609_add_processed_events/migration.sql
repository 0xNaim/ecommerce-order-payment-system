-- CreateTable
CREATE TABLE "processed_events" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_eventId_key" ON "processed_events"("eventId");
