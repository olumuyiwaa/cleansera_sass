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

  // Prevent overlapping assignments for the cleaner
  const overlap = await prisma.bookingAssignment.findFirst({ where: { cleanerId, booking: { scheduledStart: { lte: booking.scheduledEnd }, scheduledEnd: { gte: booking.scheduledStart } } }, include: { booking: true } });
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

async function completeBooking(businessId, bookingId, actorUserId) {
  await getBookingById(businessId, bookingId);
  const updated = await prisma.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED' } });
  await audit({ businessId, actorUserId, action: 'BOOKING_COMPLETED', entityType: 'Booking', entityId: bookingId });
  return updated;
}

module.exports = { listBookings, getBookingById, createBooking, updateBooking, assignBooking, confirmBooking, completeBooking };

/**
 * Computes the first future occurrence of the given dayOfWeek/startTime
 * (0 = Sunday .. 6 = Saturday, startTime as "HH:MM"), so a new schedule's
 * first run actually lands on the requested day/time instead of firing on
 * the next cron tick after creation.
 */
function computeInitialRunDate(dayOfWeek, startTime) {
  const [hh, mm] = (startTime || '09:00').split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hh, mm || 0, 0, 0);

  let daysUntilTarget = (dayOfWeek - next.getDay() + 7) % 7;
  if (daysUntilTarget === 0 && next <= now) daysUntilTarget = 7; // today's slot already passed
  next.setDate(next.getDate() + daysUntilTarget);
  return next;
}

async function createRecurringSchedule(businessId, actorUserId, payload) {
  const { customerId, frequency, dayOfWeek, startTime } = payload;
  const nextRunDate = computeInitialRunDate(dayOfWeek, startTime);
  const created = await prisma.recurringSchedule.create({ data: { businessId, customerId, frequency, dayOfWeek, startTime, nextRunDate } });
  await audit({ businessId, actorUserId, action: 'RECURRING_CREATED', entityType: 'RecurringSchedule', entityId: created.id });
  return created;
}

async function listRecurringSchedules(businessId) {
  return prisma.recurringSchedule.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
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
