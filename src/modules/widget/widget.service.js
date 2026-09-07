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

async function quote(businessId, { serviceId, addOnIds = [], latitude, longitude }) {
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
  const quote = pricing.calculateQuote(service, { addOnIds });

  // availability check: if lat/lng and a scheduledStart provided in options, skip here (handled in submit)
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
  } = payload;

  const { priceCents, estimatedMinutes } = await quote(businessId, { serviceId, addOnIds, latitude, longitude });

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

  const customer = await prisma.customer.upsert({
    where: { businessId_phone: { businessId, phone } },
    update: { firstName, lastName, email },
    create: { businessId, firstName, lastName, email, phone },
  });

  const start = new Date(scheduledStart);
  const end = new Date(start.getTime() + estimatedMinutes * 60 * 1000);

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

  for (const h of businessHours) {
    const startParts = h.openTime.split(':').map(Number);
    const endParts = h.closeTime.split(':').map(Number);
    const startDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startParts[0], startParts[1] || 0);
    const endDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endParts[0], endParts[1] || 0);

    for (let t = new Date(startDt); t.getTime() + slotLen * 60000 <= endDt.getTime(); t.setMinutes(t.getMinutes() + 30)) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t.getTime() + slotLen * 60000);
      const candidates = await scheduler.findAvailableCleaners(businessId, slotStart, slotEnd, {});
      if (candidates && candidates.length > 0) {
        slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString(), available: candidates.length });
      }
      if (slots.length >= limit) break;
    }
    if (slots.length >= limit) break;
  }

  return { date: day.toISOString().slice(0, 10), slots };
}

module.exports.slots = slots;
