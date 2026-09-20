const prisma = require('../../config/database');
const { getIo } = require('../../config/socket');
const logger = require('../../config/logger');
const notificationClient = require('../../lib/notificationClient');
const { hashToken, randomToken } = require('../../utils/tokens');
const { formatDateTime } = require('../../utils/format');

// Business timezones change rarely; a short cache avoids a query per message.
const tzCache = new Map();
async function when(businessId, date) {
  let entry = tzCache.get(businessId);
  if (!entry || entry.expires < Date.now()) {
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
    entry = { tz: (biz && biz.timezone) || 'Europe/Amsterdam', expires: Date.now() + 5 * 60 * 1000 };
    tzCache.set(businessId, entry);
  }
  return formatDateTime(date, { timeZone: entry.tz });
}

// Invite links live longer than a forgot-password link (7 days vs 1 hour) —
// the recipient didn't ask for this and may not check email right away.
const INVITE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/**
 * Sends an invite to a newly-created user (cleaner onboarding, staff invite).
 * Generates a real PasswordReset token so the link actually works — this
 * reuses the same token/route the "forgot password" flow uses, since
 * "set your password via a link" is the same operation either way.
 */
async function sendInvite(businessId, userId, { email, phone }) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS);
  await prisma.passwordReset.create({ data: { userId, token: hashToken(token), expiresAt } });

  const inviteUrl = `${process.env.APP_URL || 'https://app.cleansera.example'}/reset-password?token=${token}`;

  const title = 'You were invited to join CleanSera';
  const body = `You've been invited to join a business on CleanSera. Set your password to get started: ${inviteUrl}`;

  const recipients = userId ? [userId] : [];

  // Create notification records for any explicit recipients
  const created = [];
  for (const rid of recipients) {
    try {
      const n = await prisma.notification.create({ data: { businessId, recipientUserId: rid, type: 'INVITE', title, body } });
      created.push(n);
      try { getIo().to(`user:${rid}`).emit('notification', n); } catch (e) { /* ignore */ }
    } catch (err) {
      logger.error('failed to create invite notification', err);
    }
  }

  // Send invite via email/SMS if available
  try {
    if (email) {
      await notificationClient.sendEmail({ to: email, subject: title, text: body });
    }
    if (phone) {
      await notificationClient.sendSms({ to: phone, body });
    }
  } catch (e) {
    logger.error('failed to deliver invite via provider', e);
  }
  return created;
}

async function notifyBookingCreated(businessId, booking) {
  const members = await prisma.businessMember.findMany({ where: { businessId, isActive: true } });
  const title = 'New booking request';
  const body = `Booking requested for ${await when(businessId, booking.scheduledStart)}`;

  const created = [];
  for (const m of members) {
    try {
      const n = await prisma.notification.create({ data: { businessId, recipientUserId: m.userId, type: 'BOOKING_REQUESTED', title, body } });
      created.push(n);
      try { getIo().to(`business:${businessId}`).emit('booking_created', { booking, notification: n }); } catch (e) { /* ignore */ }
      try { getIo().to(`user:${m.userId}`).emit('notification', n); } catch (e) { /* ignore */ }
    } catch (err) {
      logger.error('failed to create booking notification', err);
    }
  }

  return created;
}

async function sendCustomerBookingConfirmation(businessId, booking, customer) {
  const title = 'Your booking request was received';
  const text = `Thanks ${customer.firstName || ''}, we received your booking for ${await when(businessId, booking.scheduledStart)}. We'll notify you when it's confirmed.`;
  try {
    if (customer.email) await notificationClient.sendEmail({ to: customer.email, subject: title, text });
    if (customer.phone) await notificationClient.sendSms({ to: customer.phone, body: text });
  } catch (e) {
    logger.error('failed to send customer booking confirmation', e);
  }
}

async function notifyCleanerAssigned(businessId, booking, cleanerUserId) {
  const title = 'You have a new assignment';
  const body = `You have been assigned to booking ${booking.id} at ${await when(businessId, booking.scheduledStart)}`;
  try {
    const n = await prisma.notification.create({ data: { businessId, recipientUserId: cleanerUserId, type: 'ASSIGNMENT', title, body } });
    try { getIo().to(`user:${cleanerUserId}`).emit('assignment', { booking, notification: n }); } catch (e) { /* ignore */ }
    await pushToCleanerByUserId(cleanerUserId, {
      title: 'New job assigned',
      body: `You've been assigned a new job on ${await when(businessId, booking.scheduledStart)}.`,
      data: { type: 'ASSIGNMENT', bookingId: booking.id },
    });
    return n;
  } catch (e) {
    logger.error('failed to notify cleaner assignment', e);
  }
}

/**
 * Sends an FCM push to every device a cleaner (identified by their userId,
 * matching how assignment notifications already address cleaners) has
 * registered, then prunes any tokens Firebase reports as dead — cheap
 * housekeeping so CleanerDeviceToken doesn't accumulate rows for
 * uninstalled apps forever.
 */
async function pushToCleanerByUserId(cleanerUserId, { title, body, data }) {
  try {
    const cleaner = await prisma.cleanerProfile.findFirst({ where: { userId: cleanerUserId }, select: { id: true } });
    if (!cleaner) return;
    const tokens = await prisma.cleanerDeviceToken.findMany({ where: { cleanerId: cleaner.id }, select: { token: true } });
    if (tokens.length === 0) return;
    const result = await notificationClient.sendPush({ tokens: tokens.map((t) => t.token), title, body, data });
    if (result?.invalidTokens?.length) {
      await prisma.cleanerDeviceToken.deleteMany({ where: { token: { in: result.invalidTokens } } });
    }
  } catch (e) {
    logger.error('failed to push to cleaner', e);
  }
}

async function listForBusiness(businessId, userId) {
  return prisma.notification.findMany({ where: { businessId, recipientUserId: userId }, orderBy: { createdAt: 'desc' }, take: 200 });
}

module.exports = { sendInvite, notifyBookingCreated, sendCustomerBookingConfirmation, notifyCleanerAssigned, pushToCleanerByUserId, listForBusiness };

/**
 * SMS (preferred, since most customers aren't logged into any app) + email
 * fallback triggered when a cleaner taps "On my way". There's no customer
 * mobile app in this product, so unlike notifyCleanerAssigned this can't be
 * a push notification — SMS/email are the only channels that reach the
 * customer directly.
 */
async function notifyOnMyWay(business, booking, customer) {
  const etaNote = "They'll arrive shortly.";
  const smsBody = `${business.name}: your cleaner is on their way! ${etaNote}`;
  try {
    if (customer?.phone) {
      await notificationClient.sendSms({ to: customer.phone, body: smsBody });
    }
    if (customer?.email) {
      await notificationClient.sendEmail({
        to: customer.email,
        subject: `${business.name}: your cleaner is on the way`,
        text: smsBody,
        html: `<p>${smsBody}</p>`,
      });
    }
  } catch (e) {
    logger.error('failed to send on-my-way notification', e);
  }
}

module.exports.notifyOnMyWay = notifyOnMyWay;
module.exports.notifyMembers = notifyMembers;

async function notifyMembers(businessId, type, title, body, extraEmit) {
  const members = await prisma.businessMember.findMany({ where: { businessId, isActive: true } });
  const created = [];
  for (const m of members) {
    try {
      const n = await prisma.notification.create({ data: { businessId, recipientUserId: m.userId, type, title, body } });
      created.push(n);
      try { getIo().to(`user:${m.userId}`).emit('notification', n); } catch (e) {}
      if (extraEmit) {
        try { getIo().to(`business:${businessId}`).emit(extraEmit.event, extraEmit.payload); } catch (e) {}
      }
    } catch (err) {
      logger.error('failed to create member notification', err);
    }
  }
  return created;
}

async function notifyBookingCancelled(businessId, booking) {
  return notifyMembers(
      businessId,
      'BOOKING_CANCELLED',
      'Booking cancelled',
      `Booking ${booking.id} scheduled for ${await when(businessId, booking.scheduledStart)} was cancelled.`,
      { event: 'booking_cancelled', payload: { booking } }
  );
}

async function notifyBookingRescheduled(businessId, booking) {
  return notifyMembers(
      businessId,
      'BOOKING_RESCHEDULED',
      'Booking rescheduled',
      `Booking ${booking.id} moved to ${await when(businessId, booking.scheduledStart)}.`,
      { event: 'booking_rescheduled', payload: { booking } }
  );
}

async function requestReview(businessId, booking, customer) {
  const title = 'How was your cleaning?';
  const text = `Hi ${customer.firstName || ''}, thanks for choosing us. Please rate your recent cleaning and leave a short review.`;
  try {
    if (customer.email) await notificationClient.sendEmail({ to: customer.email, subject: title, text });
    if (customer.phone) await notificationClient.sendSms({ to: customer.phone, body: text });
  } catch (e) {
    logger.error('failed to send review request', e);
  }
  // also notify business members that review was requested
  return notifyMembers(businessId, 'REVIEW_REQUESTED', 'Review requested', `Review request sent for booking ${booking.id}`);
}

async function sendBookingReminder(businessId, booking, customer) {
  const title = 'Upcoming cleaning reminder';
  const text = `Hi ${customer?.firstName || ''}, this is a reminder that your cleaning is scheduled for ${await when(businessId, booking.scheduledStart)}.`;
  try {
    if (customer?.email) await notificationClient.sendEmail({ to: customer.email, subject: title, text });
    if (customer?.phone) await notificationClient.sendSms({ to: customer.phone, body: text });
  } catch (e) {
    logger.error('failed to send customer reminder', e);
  }
  // also let business members know a reminder went out, distinct from the
  // original BOOKING_REQUESTED notification
  return notifyMembers(
      businessId,
      'REMINDER',
      'Reminder sent',
      `Reminder sent for booking ${booking.id}, scheduled ${await when(businessId, booking.scheduledStart)}.`
  );
}

module.exports.sendBookingReminder = sendBookingReminder;
module.exports.notifyBookingCancelled = notifyBookingCancelled;
module.exports.notifyBookingRescheduled = notifyBookingRescheduled;
module.exports.requestReview = requestReview;

async function notifyRecurringConflict(businessId, schedule, conflictingBooking, occurrenceStart) {
  return notifyMembers(
      businessId,
      'RECURRING_CONFLICT',
      'Recurring booking skipped — scheduling conflict',
      `Recurring schedule ${schedule.id} was due to create a booking for ${occurrenceStart.toISOString()} ` +
      `but the customer already has booking ${conflictingBooking.id} overlapping that time. No booking was created — please review and reschedule manually.`,
      { event: 'recurring_conflict', payload: { scheduleId: schedule.id, conflictingBookingId: conflictingBooking.id, occurrenceStart } }
  );
}

module.exports.notifyRecurringConflict = notifyRecurringConflict;