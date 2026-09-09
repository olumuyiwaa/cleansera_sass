const { retrieveEvent } = require('../../lib/stripeClient');
const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { audit } = require('../../utils/audit');

async function handle(req, res) {
  let event;
  try {
    event = await retrieveEvent(req.rawBody || req.body, req.headers['stripe-signature']);
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  const type = event ? event.type : req.body.type;
  const obj = event ? event.data.object : req.body.data && req.body.data.object;

  try {
    if (type === 'invoice.payment_succeeded') {
      const stripeSubId = obj.subscription;
      await prisma.businessSubscription.updateMany({
        where: { stripeSubscriptionId: stripeSubId },
        data: {
          status: 'ACTIVE',
          currentPeriodEnd: new Date(obj.lines.data[0].period.end * 1000),
        },
      });
    } else if (type === 'invoice.payment_failed') {
      const stripeSubId = obj.subscription;
      await prisma.businessSubscription.updateMany({
        where: { stripeSubscriptionId: stripeSubId },
        data: { status: 'PAST_DUE' },
      });
    } else if (type === 'customer.subscription.deleted') {
      const stripeSubId = obj.id;
      await prisma.businessSubscription.updateMany({
        where: { stripeSubscriptionId: stripeSubId },
        data: { status: 'CANCELED', canceledAt: new Date() },
      });
    } else if (type === 'customer.subscription.updated') {
      const stripeSubId = obj.id;
      const status = obj.status === 'active' ? 'ACTIVE' : String(obj.status || '').toUpperCase();
      await prisma.businessSubscription.updateMany({
        where: { stripeSubscriptionId: stripeSubId },
        data: { status, currentPeriodEnd: new Date(obj.current_period_end * 1000) },
      });
    } else if (type === 'checkout.session.completed') {
      // Job-level payment
      const meta = obj.metadata || {};
      if (meta.purpose === 'job_payment' && meta.bookingId) {
        const booking = await prisma.booking.findUnique({ where: { id: meta.bookingId } });
        if (booking && booking.paymentStatus !== 'PAID') {
          await prisma.booking.update({
            where: { id: meta.bookingId },
            data: {
              paymentStatus: 'PAID',
              paymentNote: `stripe_session:${obj.id};paid_at:${new Date().toISOString()}`,
            },
          });
          await audit({
            businessId: meta.businessId || booking.businessId,
            actorUserId: null,
            action: 'BOOKING_PAYMENT_RECEIVED',
            entityType: 'Booking',
            entityId: meta.bookingId,
            metadata: { sessionId: obj.id, amountTotal: obj.amount_total },
          });
          logger.info(`Booking ${meta.bookingId} marked PAID via Checkout Session ${obj.id}`);
        }
      }
    }
  } catch (e) {
    logger.error('error handling stripe webhook', e);
  }

  res.json({ received: true });
}

module.exports = { handle };
