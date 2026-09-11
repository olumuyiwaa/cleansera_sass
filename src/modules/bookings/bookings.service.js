const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const notifications = require('../notifications/notifications.service');

async function listBookings(businessId, { status } = {}) {
  return prisma.booking.findMany({
    where: { businessId, ...(status ? { status } : {}) },
    include: { customer: true, service: true, assignments: { include: { cleaner: { include: { user: true } } } } },
    orderBy: { scheduledStart: 'desc' },
    take: 200,
  });
}

async function getBookingById(businessId, id) {
  const b = await prisma.booking.findFirst({ where: { id, businessId }, include: { customer: true, service: true, assignments: true } });
  if (!b) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  return b;
}

async function createBooking(businessId, actorUserId, payload) {
  const { customerId, serviceId, addressLine1, addressLine2, city, state, latitude, longitude, scheduledStart, sqft, rooms, addOnIds, frequency, couponCode } = payload;
  const service = await prisma.service.findFirst({ where: { id: serviceId, businessId }, include: { addOns: true } });
  if (!service) {
    const err = new Error('Service not found');
    err.status = 404;
    throw err;
  }
  const customerRecord = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customerRecord) {
    const err = new Error('Customer not found for this business');
    err.status = 404;
    throw err;
  }
  const pricing = require('../../lib/pricing');
  const quote = await pricing.calculateQuote(service, { businessId, sqft, rooms, addOnIds, frequency, customDurationMinutes: service.estimatedMinutes, couponCode });

  const start = new Date(scheduledStart);
  const end = new Date(start.getTime() + (quote.breakdown.estimatedMinutes || service.estimatedMinutes) * 60 * 1000);

  // If couponCode provided, validate and enforce redemption limits within a transaction
  if (couponCode) {
    const coupon = await prisma.coupon.findFirst({ where: { businessId, code: couponCode, isActive: true } });
    if (!coupon) {
      const err = new Error('Coupon not found'); err.status = 422; throw err;
    }
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
      const err = new Error('Coupon expired'); err.status = 422; throw err;
    }
    if (coupon.appliesToServiceId && coupon.appliesToServiceId !== serviceId) {
      const err = new Error('Coupon not applicable to this service'); err.status = 422; throw err;
    }

    const booking = await prisma.$transaction(async (tx) => {
      // per-customer limit
      if (coupon.perCustomerLimit) {
        const used = await tx.booking.count({ where: { customerId, couponId: coupon.id } });
        if (used >= coupon.perCustomerLimit) {
          const err = new Error('Coupon per-customer redemption limit reached'); err.status = 422; throw err;
        }
      }

      const b = await tx.booking.create({ data: { businessId, customerId, serviceId, addressLine1, addressLine2, city, state, latitude, longitude, scheduledStart: start, scheduledEnd: end, quotedPriceCents: quote.priceCents, status: 'REQUESTED', couponId: coupon.id } });

      // attempt to increment redeemedCount with maxRedemptions enforcement
      if (coupon.maxRedemptions) {
        const updated = await tx.coupon.updateMany({ where: { id: coupon.id, redeemedCount: { lt: coupon.maxRedemptions } }, data: { redeemedCount: { increment: 1 } } });
        if (updated.count === 0) {
          const err = new Error('Coupon redemption limit reached'); err.status = 409; throw err;
        }
      } else {
        await tx.coupon.update({ where: { id: coupon.id }, data: { redeemedCount: { increment: 1 } } });
      }

      return b;
    });

    await audit({ businessId, actorUserId, action: 'BOOKING_CREATED', entityType: 'Booking', entityId: booking.id });
    await notifications.notifyBookingCreated(businessId, booking);
    try { const customer = await prisma.customer.findUnique({ where: { id: customerId } }); if (customer) await notifications.sendCustomerBookingConfirmation(businessId, booking, customer); } catch (e) {}
    return booking;
  }

  const booking = await prisma.booking.create({ data: { businessId, customerId, serviceId, addressLine1, addressLine2, city, state, latitude, longitude, scheduledStart: start, scheduledEnd: end, quotedPriceCents: quote.priceCents, status: 'REQUESTED' } });

  await audit({ businessId, actorUserId, action: 'BOOKING_CREATED', entityType: 'Booking', entityId: booking.id });
  await notifications.notifyBookingCreated(businessId, booking);
  // send confirmation to customer when contact exists
  try {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (customer) await notifications.sendCustomerBookingConfirmation(businessId, booking, customer);
  } catch (e) {
    // ignore customer notification failures
  }
  return booking;
}

async function updateBooking(businessId, id, patch) {
  const booking = await getBookingById(businessId, id);
  const updated = await prisma.booking.update({ where: { id }, data: patch });
  await audit({ businessId, action: 'BOOKING_UPDATED', entityType: 'Booking', entityId: id, metadata: patch });
  return updated;
}

async function assignBooking(businessId, bookingId, cleanerId, actorUserId) {
  const booking = await getBookingById(businessId, bookingId);
  const cleaner = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId, status: 'ACTIVE' } });
  if (!cleaner) {
    const err = new Error('Cleaner not available');
    err.status = 400;
    throw err;
  }

  // Prevent overlapping assignments for the cleaner. Excludes CANCELLED
  // bookings — otherwise a cancelled booking permanently "blocks" that
  // cleaner's slot for reassignment, since its BookingAssignment row is
  // never removed on cancel (matches the exclusion rescheduleBooking's own
  // overlap check already applies below).
  const overlap = await prisma.bookingAssignment.findFirst({
    where: {
      cleanerId,
      booking: {
        status: { not: 'CANCELLED' },
        scheduledStart: { lte: booking.scheduledEnd },
        scheduledEnd: { gte: booking.scheduledStart },
      },
    },
    include: { booking: true },
  });
  if (overlap) {
    const err = new Error('Cleaner has another booking during this time');
    err.status = 400;
    throw err;
  }

  const assignment = await prisma.bookingAssignment.create({ data: { bookingId, cleanerId } });
  await prisma.booking.update({ where: { id: bookingId }, data: { status: 'ASSIGNED' } });
  await audit({ businessId, actorUserId, action: 'BOOKING_ASSIGNED', entityType: 'BookingAssignment', entityId: assignment.id, metadata: { cleanerId } });
  // notify assigned cleaner via notifications
  const assignedCleaner = await prisma.cleanerProfile.findUnique({ where: { id: cleanerId }, include: { user: true } });
  if (assignedCleaner) {
    await notifications.notifyCleanerAssigned(businessId, booking, assignedCleaner.userId);
  }
  return assignment;
}

async function confirmBooking(businessId, bookingId, actorUserId) {
  await getBookingById(businessId, bookingId);
  const updated = await prisma.booking.update({ where: { id: bookingId }, data: { status: 'CONFIRMED' } });
  await audit({ businessId, actorUserId, action: 'BOOKING_CONFIRMED', entityType: 'Booking', entityId: bookingId });
  return updated;
}

async function completeBooking(businessId, bookingId, actorUserId, options = {}) {
  const { requestReview = true, force = false } = options;

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    include: {
      customer: true,
      service: true,
      business: true,
      checklist: true,
      assignments: true,
    },
  });

  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }

  if (booking.status === 'CANCELLED') {
    const err = new Error('Cannot complete a cancelled booking');
    err.status = 422;
    throw err;
  }

  if (booking.status === 'COMPLETED' && !force) {
    // Idempotent — already done
    return booking;
  }

  // Mark checklist completed if present and not already
  if (booking.checklist && !booking.checklist.completedAt) {
    await prisma.jobChecklist.update({
      where: { id: booking.checklist.id },
      data: { completedAt: new Date() },
    });
  }

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'COMPLETED' },
  });

  await audit({
    businessId,
    actorUserId,
    action: 'BOOKING_COMPLETED',
    entityType: 'Booking',
    entityId: bookingId,
  });

  // Optional auto-charge path (creates a Checkout Session for the customer to pay)
  // Full off-session capture requires saving a payment method — that is Phase 2.
  // For Phase 1 we generate a payment link / session and notify the customer.
  if (
      booking.autoChargeOnComplete &&
      booking.paymentStatus !== 'PAID' &&
      booking.business?.stripeChargesEnabled &&
      booking.business?.stripeConnectedAccountId &&
      booking.quotedPriceCents > 0
  ) {
    try {
      const session = await stripeClient.createBookingCheckoutSession({
        bookingId: booking.id,
        businessId,
        connectedAccountId: booking.business.stripeConnectedAccountId,
        amountCents: booking.quotedPriceCents,
        customerEmail: booking.customer?.email,
        description: `${booking.service?.name || 'Cleaning'} — ${booking.id}`,
      });

      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          stripeCheckoutSessionId: session.id,
          paymentNote: `auto_charge_session:${session.id};created_at:${new Date().toISOString()}`,
        },
      });

      // Notify customer with payment link
      try {
        await notifications.sendCustomerPaymentLink?.(
            businessId,
            booking,
            booking.customer,
            session.url
        );
      } catch (e) {
        logger.warn('Failed to send payment link notification', { bookingId, error: e.message });
      }
    } catch (chargeErr) {
      logger.error('Auto-charge session creation failed', {
        bookingId,
        error: chargeErr.message,
      });
      // Non-fatal — job is still completed
    }
  }

  // Ask for review
  if (requestReview && booking.customer) {
    try {
      await notifications.requestCustomerReview?.(businessId, booking, booking.customer);
    } catch (e) {
      // non-fatal
    }
  }

  return updated;
}

/**
 * Cleaner-facing complete path (used by the Flutter app).
 * Also records check-out location when provided.
 */
async function completeBookingByCleaner(bookingId, cleanerUserId, { lat, lng, notes } = {}) {
  const cleaner = await prisma.cleanerProfile.findFirst({
    where: { userId: cleanerUserId, status: 'ACTIVE' },
    include: { business: true },
  });
  if (!cleaner) {
    const err = new Error('Active cleaner profile not found');
    err.status = 403;
    throw err;
  }

  const assignment = await prisma.bookingAssignment.findFirst({
    where: { bookingId, cleanerId: cleaner.id },
    include: { booking: true },
  });
  if (!assignment) {
    const err = new Error('You are not assigned to this booking');
    err.status = 403;
    throw err;
  }

  // Record check-out
  await prisma.bookingAssignment.update({
    where: { id: assignment.id },
    data: {
      checkedOutAt: new Date(),
      // reuse checkIn fields if you prefer separate checkOutLat/Lng later
    },
  });

  // Update cleaner's last known location for better dispatch ranking
  if (lat != null && lng != null) {
    await prisma.cleanerProfile.update({
      where: { id: cleaner.id },
      data: {
        lastKnownLat: lat,
        lastKnownLng: lng,
        lastKnownAt: new Date(),
      },
    });
  }

  return completeBooking(cleaner.businessId, bookingId, cleanerUserId, {
    requestReview: true,
  });
}

module.exports = { listBookings, getBookingById, createBooking, updateBooking, assignBooking, confirmBooking, completeBooking };

const { computeInitialRunDate } = require('../../utils/timezone');

async function createRecurringSchedule(businessId, actorUserId, payload) {
  const { customerId, serviceId, customerAddressId, frequency, dayOfWeek, startTime } = payload;

  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) {
    const err = new Error('Customer not found for this business');
    err.status = 404;
    throw err;
  }
  const service = await prisma.service.findFirst({ where: { id: serviceId, businessId } });
  if (!service) {
    const err = new Error('Service not found for this business');
    err.status = 404;
    throw err;
  }
  if (customerAddressId) {
    const address = await prisma.customerAddress.findFirst({ where: { id: customerAddressId, customerId } });
    if (!address) {
      const err = new Error('Address does not belong to this customer');
      err.status = 422;
      throw err;
    }
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  const nextRunDate = computeInitialRunDate(dayOfWeek, startTime, business.timezone);

  const created = await prisma.recurringSchedule.create({
    data: { businessId, customerId, serviceId, customerAddressId, frequency, dayOfWeek, startTime, nextRunDate },
  });
  await audit({ businessId, actorUserId, action: 'RECURRING_CREATED', entityType: 'RecurringSchedule', entityId: created.id });
  return created;
}

async function listRecurringSchedules(businessId) {
  return prisma.recurringSchedule.findMany({
    where: { businessId },
    include: { customer: true, service: true },
    orderBy: { createdAt: 'desc' },
  });
}

async function cancelRecurringSchedule(businessId, id, actorUserId) {
  const rs = await prisma.recurringSchedule.findFirst({ where: { id, businessId } });
  if (!rs) {
    const err = new Error('Recurring schedule not found');
    err.status = 404;
    throw err;
  }
  await prisma.recurringSchedule.update({ where: { id }, data: { isActive: false } });
  await audit({ businessId, actorUserId, action: 'RECURRING_CANCELLED', entityType: 'RecurringSchedule', entityId: id });
}

module.exports.createRecurringSchedule = createRecurringSchedule;
module.exports.listRecurringSchedules = listRecurringSchedules;
module.exports.cancelRecurringSchedule = cancelRecurringSchedule;

async function pauseRecurringSchedule(businessId, id, actorUserId) {
  const rs = await prisma.recurringSchedule.findFirst({ where: { id, businessId } });
  if (!rs) {
    const err = new Error('Recurring schedule not found');
    err.status = 404;
    throw err;
  }
  await prisma.recurringSchedule.update({ where: { id }, data: { isActive: false } });
  await audit({ businessId, actorUserId, action: 'RECURRING_PAUSED', entityType: 'RecurringSchedule', entityId: id });
  return { id, isActive: false };
}

async function resumeRecurringSchedule(businessId, id, actorUserId) {
  const rs = await prisma.recurringSchedule.findFirst({ where: { id, businessId } });
  if (!rs) {
    const err = new Error('Recurring schedule not found');
    err.status = 404;
    throw err;
  }
  await prisma.recurringSchedule.update({ where: { id }, data: { isActive: true } });
  await audit({ businessId, actorUserId, action: 'RECURRING_RESUMED', entityType: 'RecurringSchedule', entityId: id });
  return { id, isActive: true };
}

module.exports.pauseRecurringSchedule = pauseRecurringSchedule;
module.exports.resumeRecurringSchedule = resumeRecurringSchedule;


async function cancelBooking(businessId, bookingId, actorUserId, reason) {
  const booking = await getBookingById(businessId, bookingId);
  if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
    const err = new Error(`Cannot cancel a booking that is already ${booking.status}`);
    err.status = 422;
    throw err;
  }
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'CANCELLED', cancelReason: reason || null },
  });
  await audit({ businessId, actorUserId, action: 'BOOKING_CANCELLED', entityType: 'Booking', entityId: bookingId, metadata: { reason } });
  try {
    await notifications.notifyBookingCancelled(businessId, updated);
  } catch (e) { /* non-fatal */ }
  return updated;
}

async function rescheduleBooking(businessId, bookingId, actorUserId, { scheduledStart, scheduledEnd }) {
  const booking = await getBookingById(businessId, bookingId);
  if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
    const err = new Error(`Cannot reschedule a booking that is ${booking.status}`);
    err.status = 422;
    throw err;
  }
  const start = new Date(scheduledStart);
  if (Number.isNaN(start.getTime())) {
    const err = new Error('Invalid scheduledStart');
    err.status = 422;
    throw err;
  }
  let end;
  if (scheduledEnd) {
    end = new Date(scheduledEnd);
  } else {
    const durationMs = new Date(booking.scheduledEnd).getTime() - new Date(booking.scheduledStart).getTime();
    end = new Date(start.getTime() + (durationMs > 0 ? durationMs : 60 * 60 * 1000));
  }

  // If assigned, check cleaner still free at new time
  const assignments = await prisma.bookingAssignment.findMany({ where: { bookingId } });
  for (const a of assignments) {
    const overlap = await prisma.bookingAssignment.findFirst({
      where: {
        cleanerId: a.cleanerId,
        bookingId: { not: bookingId },
        booking: { scheduledStart: { lte: end }, scheduledEnd: { gte: start }, status: { not: 'CANCELLED' } },
      },
    });
    if (overlap) {
      const err = new Error('Assigned cleaner is not available at the new time');
      err.status = 409;
      throw err;
    }
  }

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: { scheduledStart: start, scheduledEnd: end },
  });
  await audit({ businessId, actorUserId, action: 'BOOKING_RESCHEDULED', entityType: 'Booking', entityId: bookingId, metadata: { scheduledStart: start, scheduledEnd: end } });
  try {
    await notifications.notifyBookingRescheduled(businessId, updated);
  } catch (e) { /* non-fatal */ }
  return updated;
}

async function updatePaymentStatus(businessId, bookingId, actorUserId, { paymentStatus, paymentNote }) {
  await getBookingById(businessId, bookingId);
  const allowed = ['UNPAID', 'PAID', 'PARTIAL', 'REFUNDED'];
  if (!allowed.includes(paymentStatus)) {
    const err = new Error(`paymentStatus must be one of ${allowed.join(', ')}`);
    err.status = 422;
    throw err;
  }
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: { paymentStatus, paymentNote: paymentNote || null },
  });
  await audit({ businessId, actorUserId, action: 'BOOKING_PAYMENT_UPDATED', entityType: 'Booking', entityId: bookingId, metadata: { paymentStatus, paymentNote } });
  return updated;
}

// Override completeBooking to request review after completion
async function completeBookingWithReview(businessId, bookingId, actorUserId) {
  const booking = await getBookingById(businessId, bookingId);
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'COMPLETED' },
  });
  await audit({ businessId, actorUserId, action: 'BOOKING_COMPLETED', entityType: 'Booking', entityId: bookingId });

  // Review request (existing)
  try {
    const full = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { customer: true },
    });
    if (full?.customer) {
      await notifications.requestReview(businessId, full, full.customer);
    }
  } catch (e) { /* non-fatal */ }

  // Auto payment request if unpaid
  try {
    if (booking.paymentStatus !== 'PAID' && booking.quotedPriceCents > 0) {
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { stripeChargesEnabled: true, stripeConnectedAccountId: true },
      });
      if (business?.stripeChargesEnabled && business.stripeConnectedAccountId) {
        const { url } = await createPaymentLink(businessId, bookingId, actorUserId, {
          // optional custom success/cancel
        });
        // notify customer with payment URL
        await notifications.notifyPaymentRequest(businessId, booking, url);
      }
    }
  } catch (e) {
    // log only — never fail complete because payment failed
  }

  return updated;
}

module.exports.cancelBooking = cancelBooking;
module.exports.rescheduleBooking = rescheduleBooking;
module.exports.updatePaymentStatus = updatePaymentStatus;
module.exports.completeBooking = completeBookingWithReview;
module.exports.completeBookingByCleaner = completeBookingByCleaner;

const { createBookingCheckoutSession } = require('../../lib/stripeClient');

async function createPaymentLink(businessId, bookingId, actorUserId, { successUrl, cancelUrl, currency } = {}) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    include: { customer: true, service: true },
  });
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  if (booking.paymentStatus === 'PAID') {
    const err = new Error('Booking is already paid');
    err.status = 409;
    throw err;
  }
  if (!booking.quotedPriceCents || booking.quotedPriceCents <= 0) {
    const err = new Error('Booking has no quoted price');
    err.status = 422;
    throw err;
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { stripeConnectedAccountId: true, stripeChargesEnabled: true },
  });
  if (!business?.stripeChargesEnabled || !business?.stripeConnectedAccountId) {
    const err = new Error(
      'This business has not finished setting up Stripe Connect, so it cannot accept card payments for bookings yet. Complete Stripe onboarding in Business Settings.'
    );
    err.status = 402;
    throw err;
  }

  const session = await createBookingCheckoutSession({
    bookingId: booking.id,
    businessId,
    connectedAccountId: business.stripeConnectedAccountId,
    amountCents: booking.quotedPriceCents,
    currency: currency || process.env.DEFAULT_CURRENCY || 'usd',
    customerEmail: booking.customer?.email || undefined,
    successUrl,
    cancelUrl,
    description: `${booking.service?.name || 'Cleaning'} — ${booking.customer?.firstName || ''} ${booking.customer?.lastName || ''}`.trim(),
  });

  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      paymentNote: `stripe_session:${session.id}`,
    },
  });

  await audit({
    businessId,
    actorUserId,
    action: 'BOOKING_PAYMENT_LINK_CREATED',
    entityType: 'Booking',
    entityId: bookingId,
    metadata: { sessionId: session.id, url: session.url },
  });

  return { url: session.url, sessionId: session.id };
}

module.exports.createPaymentLink = createPaymentLink;
