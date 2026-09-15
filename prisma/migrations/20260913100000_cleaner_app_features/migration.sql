/*
  Adds:
  - BookingAssignment.onMyWayAt — set when a cleaner taps "On my way" in the
    app, which triggers an SMS/email to the customer.
  - CleanerDeviceToken — FCM registration tokens so the backend can push
    job-assignment notifications to the cleaner app.

  No existing column is dropped or retyped, so this is safe to run against
  a database with live data.
*/

-- AlterTable
ALTER TABLE "BookingAssignment" ADD COLUMN "onMyWayAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CleanerDeviceToken" (
    "id" TEXT NOT NULL,
    "cleanerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CleanerDeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CleanerDeviceToken_cleanerId_idx" ON "CleanerDeviceToken"("cleanerId");

-- CreateIndex
CREATE UNIQUE INDEX "CleanerDeviceToken_cleanerId_token_key" ON "CleanerDeviceToken"("cleanerId", "token");

-- AddForeignKey
ALTER TABLE "CleanerDeviceToken" ADD CONSTRAINT "CleanerDeviceToken_cleanerId_fkey" FOREIGN KEY ("cleanerId") REFERENCES "CleanerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
