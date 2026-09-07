const prisma = require('../config/database');
const logger = require('../config/logger');
const notifications = require('../modules/notifications/notifications.service');

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

async function processOnce() {
  const now = new Date();
  const schedules = await prisma.recurringSchedule.findMany({ where: { isActive: true, nextRunDate: { lte: now } } });
  for (const s of schedules) {
    try {
      // create booking based on recurring schedule
      const customer = await prisma.customer.findUnique({ where: { id: s.customerId }, include: { addresses: true } });
      if (!customer) continue;
      // choose a default service if none specified (not modeled on schedule) — pick first business service
      const service = await prisma.service.findFirst({ where: { businessId: s.businessId } });
      if (!service) continue;

      const start = new Date(s.nextRunDate);
      const end = new Date(start.getTime() + service.estimatedMinutes * 60 * 1000);
      const address = customer.addresses.find((a) => a.isPrimary) || customer.addresses[0];

      const booking = await prisma.booking.create({ data: { businessId: s.businessId, customerId: s.customerId, serviceId: service.id, addressLine1: address?.line1 || '', city: address?.city || '', state: address?.state || '', latitude: address?.latitude, longitude: address?.longitude, scheduledStart: start, scheduledEnd: end, quotedPriceCents: service.basePriceCents, status: 'REQUESTED' } });

      await notifications.notifyBookingCreated(s.businessId, booking);

      // advance nextRunDate
      let next = s.nextRunDate;
      if (s.frequency === 'WEEKLY') next = addDays(next, 7);
      else if (s.frequency === 'BIWEEKLY') next = addDays(next, 14);
      else if (s.frequency === 'MONTHLY') next = addMonths(next, 1);

      await prisma.recurringSchedule.update({ where: { id: s.id }, data: { nextRunDate: next } });
      logger.info('Created recurring booking', { scheduleId: s.id, bookingId: booking.id });
    } catch (e) {
      logger.error('Failed to process recurring schedule', e);
    }
  }
}

// NOTE: this module intentionally does not schedule its own cron. Scheduling
// lives in recurringDaemon.js (npm run recurring-daemon) — running both would
// double-create recurring bookings on every tick. This file exports
// processOnce() for the daemon to call, and can still be run directly for a
// single manual pass (e.g. from a one-off script or a Kubernetes Job).
if (require.main === module) {
  processOnce().catch((e) => {
    logger.error('recurring worker (single pass) failed', e);
    process.exit(1);
  });
}

module.exports = { processOnce };
