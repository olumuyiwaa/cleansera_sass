/*
  Adds a referral program:
  - Customer.referralCode — shareable code, generated lazily on read for
    existing rows (see customers.service.js ensureReferralCode), so this
    column starts NULL for every existing customer rather than requiring a
    backfill script here.
  - Booking.referredByCustomerId — audit trail of which referral (if any)
    converted this booking, for reporting.

  No existing column is dropped or retyped, so this is safe to run against
  a database with live data.
*/

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "referralCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_referralCode_key" ON "Customer"("referralCode");

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "referredByCustomerId" TEXT;
