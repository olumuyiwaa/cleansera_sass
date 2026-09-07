const prisma = require('../../config/database');
const { isWithinServiceAreas } = require('../../utils/geo');

async function getStorefront(businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { branding: true, hours: true },
  });
  const services = await prisma.service.findMany({
    where: { businessId, isActive: true },
    include: { addOns: true },
  });
  return { business, services };
}

async function quote(businessId, { serviceId, addOnIds = [], latitude, longitude, scheduledStart } = {}) {
  const service = await prisma.service.findFirst({ where: { id: serviceId, businessId, isActive: true }, include: { addOns: true } });
  if (!service) {
    const err = new Error('Service not found');
    err.status = 404;
    throw err;
  }

  if (latitude != null && longitude != null) {
    const areas = await prisma.serviceArea.findMany({ where: { businessId } });
    if (areas.length && !isWithinServiceAreas(latitude, longitude, areas)) {
      const err = new Error("This address is outside the business's service area");
      err.status = 422;
      throw err;
    }
  }

  const pricing = require('../../lib/pricing');
  const quote = await pricing.calculateQuote(service, { businessId, addOnIds, scheduledStart });

  // optional availability check: if a scheduledStart is provided, validate at-quote time
  if (scheduledStart) {
    const start = new Date(scheduledStart);
    const end = new Date(start.getTime() + (quote.breakdown.estimatedMinutes || 60) * 60 * 1000);
    const scheduler = require('../../lib/scheduler');
    const candidates = await scheduler.findAvailableCleaners(businessId, start, end, { lat: latitude, lng: longitude });
    if (!candidates || candidates.length === 0) {
      const err = new Error('No cleaners available for the requested scheduledStart');
      err.status = 422;
      throw err;
    }
  }

  return { serviceId, addOnIds, priceCents: quote.priceCents, estimatedMinutes: quote.breakdown.estimatedMinutes, breakdown: quote.breakdown };
}

/**
 * Creates the customer record (find-or-create, scoped to this business) and
 * the booking in one go — the widget's main conversion action.
 */
async function submitBooking(businessId, payload) {
  const {
    firstName, lastName, email, phone,
    addressLine1, addressLine2, city, state, latitude, longitude,
    serviceId, addOnIds = [], scheduledStart,
    couponCode,
  } = payload;

  const { priceCents, estimatedMinutes, coupon: couponInfo } = await quote(businessId, { serviceId, addOnIds, latitude, longitude, scheduledStart, couponCode });

  // availability: ensure at least one cleaner can cover the requested window
  if (scheduledStart) {
    const start = new Date(scheduledStart);
    const end = new Date(start.getTime() + estimatedMinutes * 60 * 1000);
    const scheduler = require('../../lib/scheduler');
    const candidates = await scheduler.findAvailableCleaners(businessId, start, end, { lat: latitude, lng: longitude });
    if (!candidates || candidates.length === 0) {
      const err = new Error('No cleaners available for the selected time');
      err.status = 422;
      throw err;
    }
  }

  // handle booking + coupon redemption atomically when couponCode provided
  const start = new Date(scheduledStart);
  const end = new Date(start.getTime() + estimatedMinutes * 60 * 1000);

  if (couponCode) {
    const coupon = await prisma.coupon.findFirst({ where: { businessId, code: couponCode, isActive: true } });
    if (!coupon) { const err = new Error('Coupon not found'); err.status = 422; throw err; }
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) { const err = new Error('Coupon expired'); err.status = 422; throw err; }
    if (coupon.appliesToServiceId && coupon.appliesToServiceId !== serviceId) { const err = new Error('Coupon not applicable to this service'); err.status = 422; throw err; }

    const result = await prisma.$transaction(async (tx) => {
      const cust = await tx.customer.upsert({ where: { businessId_phone: { businessId, phone } }, update: { firstName, lastName, email }, create: { businessId, firstName, lastName, email, phone } });

      if (coupon.perCustomerLimit) {
        const used = await tx.booking.count({ where: { customerId: cust.id, couponId: coupon.id } });
        if (used >= coupon.perCustomerLimit) { const err = new Error('Coupon per-customer redemption limit reached'); err.status = 422; throw err; }
      }

      const b = await tx.booking.create({ data: { businessId, customerId: cust.id, serviceId, addressLine1, addressLine2, city, state, latitude, longitude, scheduledStart: start, scheduledEnd: end, quotedPriceCents: priceCents, status: 'REQUESTED', couponId: coupon.id } });

      if (coupon.maxRedemptions) {
        const updated = await tx.coupon.updateMany({ where: { id: coupon.id, redeemedCount: { lt: coupon.maxRedemptions } }, data: { redeemedCount: { increment: 1 } } });
        if (updated.count === 0) { const err = new Error('Coupon redemption limit reached'); err.status = 409; throw err; }
      } else {
        await tx.coupon.update({ where: { id: coupon.id }, data: { redeemedCount: { increment: 1 } } });
      }

      return { booking: b, customer: cust };
    });

    const booking = result.booking;
    const customer = result.customer;
    try { const notifications = require('../notifications/notifications.service'); await notifications.notifyBookingCreated(businessId, booking); await notifications.sendCustomerBookingConfirmation(businessId, booking, customer); } catch (e) {}
    return booking;
  }

  const customer = await prisma.customer.upsert({
    where: { businessId_phone: { businessId, phone } },
    update: { firstName, lastName, email },
    create: { businessId, firstName, lastName, email, phone },
  });

  const booking = await prisma.booking.create({
    data: {
      businessId,
      customerId: customer.id,
      serviceId,
      addressLine1,
      addressLine2,
      city,
      state,
      latitude,
      longitude,
      scheduledStart: start,
      scheduledEnd: end,
      quotedPriceCents: priceCents,
      status: 'REQUESTED',
    },
  });

  // Notify business dashboard (Socket.io) + confirmation email/SMS to customer
  try {
    const notifications = require('../notifications/notifications.service');
    await notifications.notifyBookingCreated(businessId, booking);
    await notifications.sendCustomerBookingConfirmation(businessId, booking, customer);
  } catch (e) {
    // non-fatal
  }

  return booking;
}

module.exports = { getStorefront, quote, submitBooking };

/**
 * Return available time slots for a given date and service. Query: ?serviceId=&date=YYYY-MM-DD&slotMinutes=&startHour=&endHour=&limit=
 */
async function slots(businessId, query) {
  const { serviceId, date, slotMinutes = 60, startHour, endHour, limit = 20 } = query;
  if (!serviceId) {
    const err = new Error('serviceId is required');
    err.status = 422;
    throw err;
  }
  const svc = await prisma.service.findFirst({ where: { id: serviceId, businessId, isActive: true }, include: { addOns: true } });
  if (!svc) {
    const err = new Error('Service not found');
    err.status = 404;
    throw err;
  }

  const day = date ? new Date(date + 'T00:00:00') : new Date();
  const businessHours = await prisma.businessHours.findMany({ where: { businessId, dayOfWeek: day.getDay() } });

  const slotLen = parseInt(slotMinutes, 10) || svc.estimatedMinutes || 60;
  const slots = [];
  const scheduler = require('../../lib/scheduler');
  // simple per-request cache to avoid repeated scheduler queries for identical slot windows
  const _availCache = new Map();
  const cache = require('../../lib/cache');

  // try Redis cache for the whole day/service if available
  const redisKey = `slots:${businessId}:${serviceId}:${day.toISOString().slice(0,10)}:${slotLen}`;
  const cached = await cache.get(redisKey);
  if (cached) return { date: day.toISOString().slice(0, 10), slots: cached };

  for (const h of businessHours) {
    const startParts = h.openTime.split(':').map(Number);
    const endParts = h.closeTime.split(':').map(Number);
    const startDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startParts[0], startParts[1] || 0);
    const endDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endParts[0], endParts[1] || 0);

    for (let t = new Date(startDt); t.getTime() + slotLen * 60000 <= endDt.getTime(); t.setMinutes(t.getMinutes() + 30)) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t.getTime() + slotLen * 60000);
      const cacheKey = slotStart.toISOString() + '|' + slotEnd.toISOString();
      let candidates = _availCache.get(cacheKey);
      if (typeof candidates === 'undefined') {
        candidates = await scheduler.findAvailableCleaners(businessId, slotStart, slotEnd, {});
        _availCache.set(cacheKey, candidates || []);
      }
      if (candidates && candidates.length > 0) {
        slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString(), available: candidates.length });
      }
      if (slots.length >= limit) break;
    }
    if (slots.length >= limit) break;
  }

  // store in Redis short-term cache
  try { await cache.set(redisKey, slots, 30); } catch (e) { }

  return { date: day.toISOString().slice(0, 10), slots };
}

module.exports.slots = slots;
