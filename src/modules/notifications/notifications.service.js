const prisma = require('../../config/database');
const { getIo } = require('../../config/socket');
const logger = require('../../config/logger');
const notificationClient = require('../../lib/notificationClient');

async function sendInvite(businessId, userId, { email, phone, tempPassword }) {
  const title = 'You were invited to join CleanSera';
  const body = `You've been invited to join a business on CleanSera. Use the provided link to set your password.`;

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
  const body = `Booking requested for ${booking.scheduledStart}`;

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
  const text = `Thanks ${customer.firstName || ''}, we received your booking for ${booking.scheduledStart}. We'll notify you when it's confirmed.`;
  try {
    if (customer.email) await notificationClient.sendEmail({ to: customer.email, subject: title, text });
    if (customer.phone) await notificationClient.sendSms({ to: customer.phone, body: text });
  } catch (e) {
    logger.error('failed to send customer booking confirmation', e);
  }
}

async function notifyCleanerAssigned(businessId, booking, cleanerUserId) {
  const title = 'You have a new assignment';
  const body = `You have been assigned to booking ${booking.id} at ${booking.scheduledStart}`;
  try {
    const n = await prisma.notification.create({ data: { businessId, recipientUserId: cleanerUserId, type: 'ASSIGNMENT', title, body } });
    try { getIo().to(`user:${cleanerUserId}`).emit('assignment', { booking, notification: n }); } catch (e) { /* ignore */ }
    return n;
  } catch (e) {
    logger.error('failed to notify cleaner assignment', e);
  }
}

async function listForBusiness(businessId, userId) {
  return prisma.notification.findMany({ where: { businessId, recipientUserId: userId }, orderBy: { createdAt: 'desc' }, take: 200 });
}

module.exports = { sendInvite, notifyBookingCreated, sendCustomerBookingConfirmation, notifyCleanerAssigned, listForBusiness };

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
      `Booking ${booking.id} scheduled for ${booking.scheduledStart} was cancelled.`,
      { event: 'booking_cancelled', payload: { booking } }
  );
}

async function notifyBookingRescheduled(businessId, booking) {
  return notifyMembers(
      businessId,
      'BOOKING_RESCHEDULED',
      'Booking rescheduled',
      `Booking ${booking.id} moved to ${booking.scheduledStart}.`,
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
  const text = `Hi ${customer?.firstName || ''}, this is a reminder that your cleaning is scheduled for ${booking.scheduledStart}.`;
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
      `Reminder sent for booking ${booking.id}, scheduled ${booking.scheduledStart}.`
  );
}

module.exports.sendBookingReminder = sendBookingReminder;
module.exports.notifyBookingCancelled = notifyBookingCancelled;
module.exports.notifyBookingRescheduled = notifyBookingRescheduled;
module.exports.requestReview = requestReview;