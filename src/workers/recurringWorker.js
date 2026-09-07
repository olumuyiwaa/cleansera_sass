const prisma = require('../config/database');
const logger = require('../config/logger');
const notifications = require('../modules/notifications/notifications.service');
const { advanceRunDate } = require('../utils/timezone');

async function processOnce() {
  const now = new Date();
  const schedules = await prisma.recurringSchedule.findMany({
    where: { isActive: true, nextRunDate: { lte: now } },
    include: { customer: { include: { addresses: true } }, service: true, customerAddress: true, business: true },
  });

  for (const s of schedules) {
    try {
      if (!s.customer || !s.service) {
        logger.error('Recurring schedule missing customer or service, skipping', { scheduleId: s.id });
        continue;
      }

      const start = new Date(s.nextRunDate);
      const end = new Date(start.getTime() + s.service.estimatedMinutes * 60 * 1000);
      const address = s.customerAddress || s.customer.addresses.find((a) => a.isPrimary) || s.customer.addresses[0];

      let booking;
      try {
        booking = await prisma.booking.create({
          data: {
            businessId: s.businessId,
            customerId: s.customerId,
            serviceId: s.serviceId,
            recurringScheduleId: s.id,
            addressLine1: address?.line1 || '',
            addressLine2: address?.line2,
            city: address?.city || '',
            state: address?.state || '',
            latitude: address?.latitude,
            longitude: address?.longitude,
            scheduledStart: start,
            scheduledEnd: end,
            quotedPriceCents: s.service.basePriceCents,
            status: 'REQUESTED',
          },
        });
      } catch (e) {
        if (e.code === 'P2002') {
          // A booking for this schedule + start already exists — another
          // daemon tick/replica beat us to it. Not an error, just skip.
          logger.info('Recurring booking already exists for this slot, skipping', { scheduleId: s.id, start });
        } else {
          throw e;
        }
      }

      if (booking) {
        await notifications.notifyBookingCreated(s.businessId, booking);
        logger.info('Created recurring booking', { scheduleId: s.id, bookingId: booking.id });
      }

      const timezone = s.business?.timezone || 'UTC';
      const next = advanceRunDate(s.nextRunDate, s.frequency, s.startTime, timezone);
      await prisma.recurringSchedule.update({ where: { id: s.id }, data: { nextRunDate: next } });
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
