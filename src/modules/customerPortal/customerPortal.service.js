/**
 * Lightweight customer self-service portal.
 * Access is phone + one-time code (OTP stored in OtpCode with purpose CUSTOMER_PORTAL).
 * All actions are scoped to a single business resolved from the Host header (widget style).
 */
const crypto = require('crypto');
const prisma = require('../../config/database');
const notificationClient = require('../../lib/notificationClient');
const logger = require('../../config/logger');

const OTP_TTL_MS = 10 * 60 * 1000;

async function requestAccess(businessId, { phone }) {
  const customer = await prisma.customer.findUnique({
    where: { businessId_phone: { businessId, phone } },
  });
  if (!customer) {
    // Do not leak existence — still return success shape
    return { sent: true };
  }

  // Reuse User OTP table if customer has a user link; otherwise store ephemeral on a system approach.
  // Simplest path: create a short-lived token in OtpCode attached to a synthetic flow via Audit isn't ideal.
  // We store OTP against a platform User if one exists with that phone, else email/SMS the code and
  // verify against a hash kept only in memory is not multi-instance safe.
  // Practical approach: create/find a lightweight User by phone for portal access only when needed.

  let user = await prisma.user.findFirst({ where: { phone } });
  if (!user) {
    const tempPassword = crypto.randomBytes(16).toString('hex');
    const bcrypt = require('bcryptjs');
    user = await prisma.user.create({
      data: {
        email: customer.email || `${phone.replace(/\D/g, '')}@portal.cleansera.local`,
        phone,
        firstName: customer.firstName,
        lastName: customer.lastName,
        passwordHash: await bcrypt.hash(tempPassword, 10),
        isActive: true,
      },
    });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.otpCode.create({
    data: {
      userId: user.id,
      code,
      purpose: 'CUSTOMER_PORTAL',
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
  const customer = await prisma.customer.findUnique({
    where: { businessId_phone: { businessId, phone } },
  });
  if (!customer) {
    const err = new Error('Invalid phone or code');
    err.status = 401;
    throw err;
  }
  const user = await prisma.user.findFirst({ where: { phone } });
  if (!user) {
    const err = new Error('Invalid phone or code');
    err.status = 401;
    throw err;
  }
  const otp = await prisma.otpCode.findFirst({
    where: {
      userId: user.id,
      purpose: 'CUSTOMER_PORTAL',
      code,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) {
    const err = new Error('Invalid or expired code');
    err.status = 401;
    throw err;
  }
  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

  // Issue a short-lived portal token (JWT-like via existing util if available)
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { sub: user.id, businessId, portalCustomerId: customer.id, scope: 'CUSTOMER_PORTAL' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
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

async function cancelMyBooking(businessId, customerId, bookingId, reason) {
  const b = await getMyBooking(businessId, customerId, bookingId);
  if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(b.status)) {
    const err = new Error(`Cannot cancel a booking that is ${b.status}`);
    err.status = 422;
    throw err;
  }
  // Only allow cancel if more than 12 hours away
  const hoursUntil = (new Date(b.scheduledStart) - new Date()) / 3600000;
  if (hoursUntil < 12) {
    const err = new Error('Cancellations must be at least 12 hours before the appointment');
    err.status = 422;
    throw err;
  }
  return prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'CANCELLED', cancelReason: reason || 'Cancelled by customer' },
  });
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
};
