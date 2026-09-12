/*
  Adds:
  - ORG_ADMIN to BusinessMemberRole (previously referenced by route guards
    and scopeToBusiness.js but never assignable — franchise/location admin
    endpoints were unreachable).
  - PolicyValueType enum (PERCENT | AMOUNT), reused for both deposit and
    cancellation-fee amounts.
  - BusinessPricing deposit + cancellation-policy columns (all nullable —
    existing rows keep today's behavior: no deposit, no cancellation fee).
  - Booking deposit / tip / cancellation-fee / refund columns.

  No existing column is dropped or retyped, so this is safe to run against
  a database with live data.
*/

-- AlterEnum
ALTER TYPE "BusinessMemberRole" ADD VALUE 'ORG_ADMIN';

-- CreateEnum
CREATE TYPE "PolicyValueType" AS ENUM ('PERCENT', 'AMOUNT');

-- AlterTable
ALTER TABLE "BusinessPricing"
  ADD COLUMN "depositType" "PolicyValueType",
  ADD COLUMN "depositValue" INTEGER,
  ADD COLUMN "cancellationWindowHours" INTEGER,
  ADD COLUMN "cancellationFeeType" "PolicyValueType",
  ADD COLUMN "cancellationFeeValue" INTEGER;

-- AlterTable
ALTER TABLE "Booking"
  ADD COLUMN "depositRequiredCents" INTEGER,
  ADD COLUMN "depositPaidAt" TIMESTAMP(3),
  ADD COLUMN "stripeDepositSessionId" TEXT,
  ADD COLUMN "stripeDepositPaymentIntentId" TEXT,
  ADD COLUMN "tipAmountCents" INTEGER,
  ADD COLUMN "tipPaidAt" TIMESTAMP(3),
  ADD COLUMN "stripeTipSessionId" TEXT,
  ADD COLUMN "stripeTipPaymentIntentId" TEXT,
  ADD COLUMN "cancellationFeeCents" INTEGER,
  ADD COLUMN "refundedAmountCents" INTEGER,
  ADD COLUMN "refundedAt" TIMESTAMP(3),
  ADD COLUMN "stripeRefundId" TEXT;
