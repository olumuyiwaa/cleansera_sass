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
