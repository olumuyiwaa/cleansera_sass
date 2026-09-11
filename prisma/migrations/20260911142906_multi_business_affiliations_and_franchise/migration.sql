/*
  Warnings:

  - A unique constraint covering the columns `[businessId,userId]` on the table `CleanerProfile` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "CleanerProfile_userId_key";

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "parentBusinessId" TEXT;

-- AlterTable
ALTER TABLE "CleanerProfile" ADD COLUMN     "lastKnownAt" TIMESTAMP(3),
ADD COLUMN     "lastKnownLat" DOUBLE PRECISION,
ADD COLUMN     "lastKnownLng" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "cleanerId" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "businessId" TEXT;

-- CreateIndex
CREATE INDEX "Business_parentBusinessId_idx" ON "Business"("parentBusinessId");

-- CreateIndex
CREATE INDEX "CleanerProfile_userId_idx" ON "CleanerProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CleanerProfile_businessId_userId_key" ON "CleanerProfile"("businessId", "userId");

-- CreateIndex
CREATE INDEX "Review_cleanerId_idx" ON "Review"("cleanerId");

-- AddForeignKey
ALTER TABLE "Business" ADD CONSTRAINT "Business_parentBusinessId_fkey" FOREIGN KEY ("parentBusinessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_cleanerId_fkey" FOREIGN KEY ("cleanerId") REFERENCES "CleanerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
