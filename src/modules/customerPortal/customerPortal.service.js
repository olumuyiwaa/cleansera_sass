/**
 * Lightweight customer self-service portal.
 * Access is phone + one-time code (OTP stored in OtpCode with purpose CUSTOMER_PORTAL).
 * All actions are scoped to a single business resolved from the Host header (widget style).
 */
const crypto = require('crypto');
const prisma = require('../../config/database');
const notificationClient = require('../../lib/notificationClient');
const logger = require('../../config/logger');
const { createAncillaryCheckoutSession } = require('../../lib/stripeClient');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_REQUESTS_PER_WINDOW = 3;
const OTP_MAX_FAILED_ATTEMPTS = 5;
const PORTAL_TOKEN_TTL = process.env.PORTAL_TOKEN_EXPIRY || '24h';

const PURPOSE_CODE = 'CUSTOMER_PORTAL';
// Failed guesses are recorded as rows of their own so they can be counted per
// portal identity across server instances without a schema change.
const PURPOSE_FAILED = 'CUSTOMER_PORTAL_FAILED';

function tooMany(message) {
  const err = new Error(message);
  err.status = 429;
  return err;
}

/**
 * Each portal customer gets a dedicated identity row that can never hold a
 * membership or a cleaner profile. The previous implementation attached the
 * OTP to whichever User had the same phone number — which could be a business
 * owner or cleaner — and then signed a token for that user, so a portal login
 * could be turned into a staff session.
 */
function portalEmailFor(customerId) {
  return `portal-${customerId}@portal.invalid`;
}

async function findOrCreatePortalUser(customer) {
  const email = portalEmailFor(customer.id);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  const bcrypt = require('bcryptjs');
  return prisma.user.create({
    data: {
      email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      isActive: true,
    },
  });
}

const { generateNumericCode, hashOtp: hashCode } = require('../../lib/otp');

async function requestAccess(businessId, { phone }) {
  const customer = await prisma.customer.findUnique({
    where: { businessId_phone: { businessId, phone } },
  });
  if (!customer) {
    // Do not leak existence — still return success shape
    return { sent: true };
  }

  const user = await findOrCreatePortalUser(customer);
  const since = new Date(Date.now() - OTP_TTL_MS);

  // Cap how many codes can be requested per window (SMS-bombing / cost abuse).
  // Answer with the normal success shape so the cap does not reveal anything.
  const recent = await prisma.otpCode.count({
    where: { userId: user.id, purpose: PURPOSE_CODE, createdAt: { gte: since } },
  });
  if (recent >= OTP_MAX_REQUESTS_PER_WINDOW) return { sent: true };

  // Only the newest code is ever valid.
  await prisma.otpCode.updateMany({
    where: { userId: user.id, purpose: PURPOSE_CODE, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = generateNumericCode();
  if (process.env.NODE_ENV !== 'production') {
    logger.info(`[DEV] Portal OTP for ${phone}: ${code}`);
    console.log(`[DEV] Portal OTP for ${phone}: ${code}`);
  }
  await prisma.otpCode.create({
    data: {
      userId: user.id,
      code: hashCode(user.id, code),
      purpose: PURPOSE_CODE,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  const text = `Your CleanSera access code is ${code}. It expires in 10 minutes.`;
  try {
    if (customer.phone) await notificationClient.sendSms({ to: customer.phone, body: text });
    if (customer.email) await notificationClient.sendEmail({ to: customer.email, subject: 'Your access code', text });
  } catch (e) {
    logger.error('failed to send portal OTP', e);
  }

  return { sent: true };
}

async function verifyAccess(businessId, { phone, code }) {
  const invalid = () => {
    const err = new Error('Invalid or expired code');
    err.status = 401;
    return err;
  };

  const customer = await prisma.customer.findUnique({
    where: { businessId_phone: { businessId, phone } },
  });
  if (!customer) throw invalid();

  const user = await prisma.user.findUnique({ where: { email: portalEmailFor(customer.id) } });
  if (!user) throw invalid();

  const since = new Date(Date.now() - OTP_TTL_MS);
  const failures = await prisma.otpCode.count({
    where: { userId: user.id, purpose: PURPOSE_FAILED, createdAt: { gte: since } },
  });
  if (failures >= OTP_MAX_FAILED_ATTEMPTS) {
    // Burn any outstanding code: after too many wrong guesses the customer
    // has to request a fresh one, which is itself rate limited.
    await prisma.otpCode.updateMany({
      where: { userId: user.id, purpose: PURPOSE_CODE, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    throw tooMany('Too many incorrect codes. Request a new code and try again.');
  }

  const otp = await prisma.otpCode.findFirst({
    where: {
      userId: user.id,
      purpose: PURPOSE_CODE,
      code: hashCode(user.id, String(code)),
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) {
    await prisma.otpCode.create({
      data: { userId: user.id, code: 'x', purpose: PURPOSE_FAILED, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
    throw invalid();
  }
  await prisma.otpCode.updateMany({
    where: { userId: user.id, purpose: { in: [PURPOSE_CODE, PURPOSE_FAILED] }, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  // The audience marks this as a customer-portal token. authenticate()
  // rejects any token that carries one, so it can never act as a staff or
  // cleaner session even though it shares the signing secret.
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { sub: user.id, businessId, portalCustomerId: customer.id, scope: 'CUSTOMER_PORTAL' },
    process.env.JWT_SECRET,
    { expiresIn: PORTAL_TOKEN_TTL, audience: 'customer-portal' }
  );

  return {
    token,
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
    },
  };
}

async function listMyBookings(businessId, customerId) {
  return prisma.booking.findMany({
    where: { businessId, customerId },
    include: { service: true, assignments: { include: { cleaner: { include: { user: { select: { firstName: true, lastName: true } } } } } } },
    orderBy: { scheduledStart: 'desc' },
    take: 100,
  });
}

async function getMyBooking(businessId, customerId, bookingId) {
  const b = await prisma.booking.findFirst({
    where: { id: bookingId, businessId, customerId },
    include: { service: true, checklist: true, photos: true, review: true },
  });
  if (!b) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  return b;
}

/**
 * Customer self-service cancellation. Unlike the old hardcoded "must be
 * >12h out or reject outright" rule, this always allows the cancellation
 * (a customer who genuinely can't make it should be able to cancel any
 * time) and instead applies the business's cancellation-fee policy — a
 * late cancellation costs money rather than being blocked. A business that
 * hasn't configured a policy still allows free cancellation at any time.
 */
async function cancelMyBooking(businessId, customerId, bookingId, reason) {
  const b = await getMyBooking(businessId, customerId, bookingId);
  if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(b.status)) {
    const err = new Error(`Cannot cancel a booking that is ${b.status}`);
    err.status = 422;
    throw err;
  }

  // Delegate to the same path staff use. The portal used to carry its own
  // copy that refunded a single PaymentIntent, never gave back gift card value
  // or coupon redemptions, and — because it skipped the notifications — left
  // the business and the assigned cleaner unaware the job was cancelled.
  return require('../bookings/bookings.service').cancelBooking(
    businessId,
    bookingId,
    null,
    reason || 'Cancelled by customer'
  );
}

/**
 * Customer-initiated tip on a completed booking. Creates a Checkout Session
 * for the tip amount, settled to the business's connected account with no
 * platform application fee (the platform's 1.5% is meant to come out of the
 * job charge, not out of a cleaner's tip).
 */
async function tipMyBooking(businessId, customerId, bookingId, { amountCents, successUrl, cancelUrl }) {
  const b = await getMyBooking(businessId, customerId, bookingId);
  if (b.status !== 'COMPLETED') {
    const err = new Error('You can only tip on a completed booking');
    err.status = 422;
    throw err;
  }
  if (!amountCents || amountCents < 50) {
    const err = new Error('Tip amount must be at least 50 minor units');
    err.status = 422;
    throw err;
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { stripeConnectedAccountId: true, stripeChargesEnabled: true, currency: true },
  });
  if (!business?.stripeChargesEnabled || !business?.stripeConnectedAccountId) {
    const err = new Error('This business cannot accept card payments yet');
    err.status = 402;
    throw err;
  }

  const session = await createAncillaryCheckoutSession({
    purpose: 'tip',
    bookingId,
    businessId,
    connectedAccountId: business.stripeConnectedAccountId,
    amountCents,
    currency: business.currency,
    successUrl,
    cancelUrl,
    description: `Tip for booking ${bookingId}`,
    applyPlatformFee: false,
  });

  await prisma.booking.update({
    where: { id: bookingId },
    data: { stripeTipSessionId: session.id },
  });

  return { url: session.url, sessionId: session.id };
}

async function rescheduleMyBooking(businessId, customerId, bookingId, { scheduledStart }) {
  const b = await getMyBooking(businessId, customerId, bookingId);
  if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(b.status)) {
    const err = new Error(`Cannot reschedule a booking that is ${b.status}`);
    err.status = 422;
    throw err;
  }
  const start = new Date(scheduledStart);
  if (Number.isNaN(start.getTime()) || start < new Date()) {
    const err = new Error('scheduledStart must be a future datetime');
    err.status = 422;
    throw err;
  }
  const durationMs = new Date(b.scheduledEnd) - new Date(b.scheduledStart);
  const end = new Date(start.getTime() + (durationMs > 0 ? durationMs : 3600000));

  // basic availability
  const scheduler = require('../../lib/scheduler');
  const candidates = await scheduler.findAvailableCleaners(businessId, start, end, {
    lat: b.latitude,
    lng: b.longitude,
  });
  if (!candidates || candidates.length === 0) {
    const err = new Error('No availability at the requested time');
    err.status = 422;
    throw err;
  }

  return prisma.booking.update({
    where: { id: bookingId },
    data: { scheduledStart: start, scheduledEnd: end, status: b.status === 'ASSIGNED' ? 'CONFIRMED' : b.status },
  });
}

async function leaveReview(businessId, customerId, bookingId, { rating, comment }) {
  const b = await getMyBooking(businessId, customerId, bookingId);
  if (b.status !== 'COMPLETED') {
    const err = new Error('You can only review completed bookings');
    err.status = 422;
    throw err;
  }
  if (b.review) {
    const err = new Error('Review already submitted');
    err.status = 409;
    throw err;
  }
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) {
    const err = new Error('rating must be an integer 1-5');
    err.status = 422;
    throw err;
  }
  // Attribute the review to whichever cleaner actually did the job. A
  // booking can in principle carry more than one assignment (reassignment
  // history) — the most recently assigned cleaner is the one who completed
  // it, so that's who the rating reflects.
  const primaryAssignment = await prisma.bookingAssignment.findFirst({
    where: { bookingId },
    orderBy: { assignedAt: 'desc' },
  });

  return prisma.review.create({
    data: {
      businessId,
      bookingId,
      customerId,
      cleanerId: primaryAssignment?.cleanerId || null,
      rating: r,
      comment: comment || null,
    },
  });
}

module.exports = {
  requestAccess,
  verifyAccess,
  listMyBookings,
  getMyBooking,
  cancelMyBooking,
  rescheduleMyBooking,
  leaveReview,
  tipMyBooking,
};
