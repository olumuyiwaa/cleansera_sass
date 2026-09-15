-- AlterTable
ALTER TABLE "BusinessMember" ADD COLUMN     "invitedByUserId" TEXT,
ADD COLUMN     "removedAt" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "CompensationType" AS ENUM ('PERCENT', 'FLAT_PER_JOB', 'HOURLY');

-- CreateEnum
CREATE TYPE "EarningStatus" AS ENUM ('PENDING', 'IN_PAYOUT', 'PAID', 'VOIDED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PAID', 'CANCELED');

-- CreateTable
CREATE TABLE "CleanerCompensation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cleanerId" TEXT NOT NULL,
    "type" "CompensationType" NOT NULL DEFAULT 'PERCENT',
    "value" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CleanerCompensation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleanerEarning" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cleanerId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "compensationType" "CompensationType" NOT NULL,
    "compensationValue" INTEGER NOT NULL,
    "status" "EarningStatus" NOT NULL DEFAULT 'PENDING',
    "payoutId" TEXT,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CleanerEarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cleanerId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "method" TEXT,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CleanerCompensation_cleanerId_key" ON "CleanerCompensation"("cleanerId");

-- CreateIndex
CREATE INDEX "CleanerCompensation_businessId_idx" ON "CleanerCompensation"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "CleanerEarning_bookingId_cleanerId_key" ON "CleanerEarning"("bookingId", "cleanerId");

-- CreateIndex
CREATE INDEX "CleanerEarning_businessId_idx" ON "CleanerEarning"("businessId");

-- CreateIndex
CREATE INDEX "CleanerEarning_cleanerId_idx" ON "CleanerEarning"("cleanerId");

-- CreateIndex
CREATE INDEX "CleanerEarning_cleanerId_status_idx" ON "CleanerEarning"("cleanerId", "status");

-- CreateIndex
CREATE INDEX "Payout_businessId_idx" ON "Payout"("businessId");

-- CreateIndex
CREATE INDEX "Payout_cleanerId_idx" ON "Payout"("cleanerId");

-- CreateIndex
CREATE INDEX "Payout_businessId_status_idx" ON "Payout"("businessId", "status");

-- AddForeignKey
ALTER TABLE "CleanerCompensation" ADD CONSTRAINT "CleanerCompensation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanerCompensation" ADD CONSTRAINT "CleanerCompensation_cleanerId_fkey" FOREIGN KEY ("cleanerId") REFERENCES "CleanerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanerEarning" ADD CONSTRAINT "CleanerEarning_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanerEarning" ADD CONSTRAINT "CleanerEarning_cleanerId_fkey" FOREIGN KEY ("cleanerId") REFERENCES "CleanerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanerEarning" ADD CONSTRAINT "CleanerEarning_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanerEarning" ADD CONSTRAINT "CleanerEarning_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_cleanerId_fkey" FOREIGN KEY ("cleanerId") REFERENCES "CleanerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
