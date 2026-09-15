/*
  Replaces RecurringSchedule.isActive (Boolean) with RecurringSchedule.status
  (RecurringScheduleStatus: ACTIVE | PAUSED | CANCELLED).

  Why: pause and cancel both set isActive=false, so once a schedule was
  cancelled there was no way to tell it apart from a paused one — a resume
  call could reactivate a schedule the customer had actually cancelled.

  Data migration: existing isActive=true rows -> ACTIVE, isActive=false rows
  -> CANCELLED (the safe assumption: with no prior status column we cannot
  recover which false rows were "just paused" vs "cancelled", and defaulting
  to CANCELLED means a false "paused" row would require a fresh schedule to
  restart rather than silently resuming something the business believed was
  fully stopped).
*/

-- CreateEnum
CREATE TYPE "RecurringScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- AlterTable: add nullable first, backfill, then enforce NOT NULL + default
ALTER TABLE "RecurringSchedule" ADD COLUMN "status" "RecurringScheduleStatus";

UPDATE "RecurringSchedule" SET "status" = CASE WHEN "isActive" THEN 'ACTIVE' ELSE 'CANCELLED' END::"RecurringScheduleStatus";

ALTER TABLE "RecurringSchedule" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "RecurringSchedule" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

ALTER TABLE "RecurringSchedule" DROP COLUMN "isActive";

-- CreateIndex
CREATE INDEX "RecurringSchedule_status_nextRunDate_idx" ON "RecurringSchedule"("status", "nextRunDate");
