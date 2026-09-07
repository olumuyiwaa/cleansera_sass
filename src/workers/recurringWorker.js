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
      const customer = await prisma.customer.findUnique({ where: { id: s.customerId } });
      if (!customer) continue;
      // choose a default service if none specified (not modeled on schedule) — pick first business service
      const service = await prisma.service.findFirst({ where: { businessId: s.businessId } });
      if (!service) continue;

      const start = new Date(s.nextRunDate);
      const end = new Date(start.getTime() + service.estimatedMinutes * 60 * 1000);

      const booking = await prisma.booking.create({ data: { businessId: s.businessId, customerId: s.customerId, serviceId: service.id, addressLine1: customer.addresses?.[0]?.line1 || '', city: customer.addresses?.[0]?.city || '', state: customer.addresses?.[0]?.state || '', scheduledStart: start, scheduledEnd: end, quotedPriceCents: service.basePriceCents, status: 'REQUESTED' } });

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

async function startDaemon(cronExpr = null) {
  if (cronExpr) {
    const cron = require('node-cron');
    cron.schedule(cronExpr, () => processOnce());
    logger.info('recurring worker scheduled', { cronExpr });
  } else {
    await processOnce();
  }
}

if (require.main === module) {
  const cronExpr = process.env.RECURRING_CRON || null;
  startDaemon(cronExpr).catch((e) => {
    logger.error('recurring worker failed', e);
    process.exit(1);
  });
}

module.exports = { processOnce, startDaemon };
