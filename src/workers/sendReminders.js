const prisma = require('../config/database');
const notifications = require('../modules/notifications/notifications.service');
const logger = require('../config/logger');

// Sends reminders for bookings scheduled within the next `HOURS_AHEAD` hours
async function sendReminders() {
  const HOURS_AHEAD = parseInt(process.env.REMINDER_HOURS_AHEAD || '24', 10);
  const now = new Date();
  const upper = new Date(now.getTime() + HOURS_AHEAD * 60 * 60 * 1000);

  const bookings = await prisma.booking.findMany({
    where: {
      scheduledStart: { gte: now, lt: upper },
      status: { in: ['REQUESTED', 'CONFIRMED'] },
    },
    include: { customer: true, service: true },
  });

  logger.info(`Found ${bookings.length} bookings to remind`);

  for (const b of bookings) {
    try {
      // create DB notification for members
      await notifications.notifyBookingCreated(b.businessId, b);
      // send customer confirmation/reminder
      if (b.customer) {
        await notifications.sendCustomerBookingConfirmation(b.businessId, b, b.customer);
      }
    } catch (e) {
      logger.error('failed to send reminder for booking', b.id, e);
    }
  }
}

if (require.main === module) {
  sendReminders()
    .then(() => {
      logger.info('sendReminders finished');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('sendReminders failed', err);
      process.exit(1);
    });
}

module.exports = { sendReminders };
