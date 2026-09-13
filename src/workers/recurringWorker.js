const prisma = require('../config/database');
const logger = require('../config/logger');
const notifications = require('../modules/notifications/notifications.service');
const { advanceRunDate } = require('../utils/timezone');

async function processOnce() {
  const now = new Date();
  const schedules = await prisma.recurringSchedule.findMany({
    where: { status: 'ACTIVE', nextRunDate: { lte: now } },
    include: {
      customer: { include: { addresses: true } },
      service: true,
      customerAddress: true,
      business: true,
    },
    // Limit per tick so a large backlog doesn't starve the process
    take: 100,
    orderBy: { nextRunDate: 'asc' },
  });

  let createdCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const s of schedules) {
    try {
      if (!s.customer || !s.service || !s.business) {
        logger.error('Recurring schedule missing required relations, deactivating', {
          scheduleId: s.id,
        });
        await prisma.recurringSchedule.update({
          where: { id: s.id },
          data: { status: 'CANCELLED' },
        });
        errorCount += 1;
        continue;
      }

      const timezone = s.business.timezone || 'UTC';
      const start = new Date(s.nextRunDate);
      const end = new Date(start.getTime() + (s.service.estimatedMinutes || 60) * 60 * 1000);

      const address =
          s.customerAddress ||
          s.customer.addresses.find((a) => a.isPrimary) ||
          s.customer.addresses[0];

      if (!address || !address.line1) {
        logger.warn('Recurring schedule has no usable address, skipping this tick', {
          scheduleId: s.id,
        });
        // Still advance so we don't get stuck on a broken schedule forever
        const next = advanceRunDate(s.nextRunDate, s.frequency, s.startTime, timezone);
        await prisma.recurringSchedule.update({
          where: { id: s.id },
          data: { nextRunDate: next },
        });
        skippedCount += 1;
        continue;
      }

      // Compute next run date first so we can update it even on P2002
      const nextRunDate = advanceRunDate(s.nextRunDate, s.frequency, s.startTime, timezone);

      // Conflict check: has this customer got another (non-cancelled) booking
      // that overlaps this occurrence? This can happen if they also booked a
      // one-off job for the same slot, or if two recurring schedules were
      // created before the creation-time conflict check below existed.
      // Rather than silently double-booking the customer, skip this
      // occurrence, flag it, and let a human resolve it.
      const conflict = await prisma.booking.findFirst({
        where: {
          businessId: s.businessId,
          customerId: s.customerId,
          status: { notIn: ['CANCELLED'] },
          scheduledStart: { lt: end },
          scheduledEnd: { gt: start },
        },
      });
      if (conflict) {
        await prisma.recurringSchedule.update({ where: { id: s.id }, data: { nextRunDate } });
        logger.warn('Recurring occurrence conflicts with an existing booking, skipped', {
          scheduleId: s.id,
          conflictingBookingId: conflict.id,
          occurrenceStart: start.toISOString(),
        });
        try {
          await notifications.notifyRecurringConflict(s.businessId, s, conflict, start);
        } catch (notifyErr) {
          logger.warn('Failed to notify recurring conflict', { scheduleId: s.id, error: notifyErr.message });
        }
        skippedCount += 1;
        continue;
      }

      let booking = null;
      let wasDuplicate = false;

      try {
        // Use a transaction: create booking + advance nextRunDate together.
        // The unique constraint on (recurringScheduleId, scheduledStart) is the
        // safety net against concurrent daemon instances.
        const result = await prisma.$transaction(async (tx) => {
          const b = await tx.booking.create({
            data: {
              businessId: s.businessId,
              customerId: s.customerId,
              serviceId: s.serviceId,
              recurringScheduleId: s.id,
              addressLine1: address.line1,
              addressLine2: address.line2,
              city: address.city || '',
              state: address.state || '',
              latitude: address.latitude,
              longitude: address.longitude,
              scheduledStart: start,
              scheduledEnd: end,
              quotedPriceCents: s.service.basePriceCents,
              status: 'REQUESTED',
              paymentStatus: 'UNPAID',
            },
          });

          await tx.recurringSchedule.update({
            where: { id: s.id },
            data: { nextRunDate },
          });

          return b;
        });
        booking = result;
      } catch (e) {
        if (e.code === 'P2002') {
          // Another replica / previous tick already created this slot.
          // Still advance nextRunDate so we don't re-process the same slot.
          wasDuplicate = true;
          await prisma.recurringSchedule.update({
            where: { id: s.id },
            data: { nextRunDate },
          });
          logger.info('Recurring booking already exists for this slot, advanced schedule', {
            scheduleId: s.id,
            start: start.toISOString(),
          });
        } else {
          throw e;
        }
      }

      if (booking) {
        try {
          await notifications.notifyBookingCreated(s.businessId, booking);
        } catch (notifyErr) {
          logger.warn('Failed to notify for recurring booking', {
            bookingId: booking.id,
            error: notifyErr.message,
          });
        }
        logger.info('Created recurring booking', {
          scheduleId: s.id,
          bookingId: booking.id,
          nextRunDate: nextRunDate.toISOString(),
        });
        createdCount += 1;
      } else if (wasDuplicate) {
        skippedCount += 1;
      }
    } catch (e) {
      errorCount += 1;
      logger.error('Failed to process recurring schedule', {
        scheduleId: s.id,
        error: e.message,
        stack: e.stack,
      });
      // Do NOT advance nextRunDate on unexpected errors — allow retry next tick
    }
  }

  logger.info('recurring processOnce finished', {
    scanned: schedules.length,
    created: createdCount,
    skipped: skippedCount,
    errors: errorCount,
  });

  return { scanned: schedules.length, created: createdCount, skipped: skippedCount, errors: errorCount };
}

// NOTE: this module intentionally does not schedule its own cron. Scheduling
// lives in recurringDaemon.js (npm run recurring-daemon) — running both would
// double-create recurring bookings on every tick. This file exports
// processOnce() for the daemon to call, and can still be run directly for a
// single manual pass (e.g. from a one-off script or a Kubernetes Job).
//
// FIXED: this file previously had *two* `if (require.main === module) {...}`
// blocks back to back. Both conditions are true on a direct `node
// recurringWorker.js` run, and neither awaits the other, so processOnce() was
// being kicked off twice concurrently on every manual/Job run (the unique
// constraint on (recurringScheduleId, scheduledStart) prevented duplicate
// bookings, but the run still did the scan/notify work twice and could exit
// with whichever pass's exit code happened to land second). Consolidated
// into a single block.
if (require.main === module) {
  processOnce()
      .then((stats) => {
        logger.info('recurring worker (single pass) done', stats);
        process.exit(stats.errors > 0 ? 1 : 0);
      })
      .catch((e) => {
        logger.error('recurring worker (single pass) failed', e);
        process.exit(1);
      });
}

module.exports = { processOnce };
