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
      const subscription = await prisma.businessSubscription.findFirst({ where: { stripeSubscriptionId: stripeSubId } });
      if (subscription) {
        await prisma.businessSubscription.update({
          where: { id: subscription.id },
          data: {
            status: 'ACTIVE',
            currentPeriodEnd: new Date(obj.lines.data[0].period.end * 1000),
          },
        });
        // Keep a billing-history record for the business — previously this
        // model was defined in the schema but nothing ever wrote to it, so
        // businesses had no invoice history for what they pay CleanSera.
        await prisma.platformInvoice.upsert({
          where: { stripeInvoiceId: obj.id },
          create: {
            subscriptionId: subscription.id,
            stripeInvoiceId: obj.id,
            amountCents: obj.amount_paid,
            status: 'paid',
            issuedAt: new Date(obj.created * 1000),
            paidAt: new Date(),
          },
          update: { status: 'paid', paidAt: new Date(), amountCents: obj.amount_paid },
        });
      }
    } else if (type === 'invoice.payment_failed') {
      const stripeSubId = obj.subscription;
      const subscription = await prisma.businessSubscription.findFirst({ where: { stripeSubscriptionId: stripeSubId } });
      if (subscription) {
        await prisma.businessSubscription.update({ where: { id: subscription.id }, data: { status: 'PAST_DUE' } });
        await prisma.platformInvoice.upsert({
          where: { stripeInvoiceId: obj.id },
          create: {
            subscriptionId: subscription.id,
            stripeInvoiceId: obj.id,
            amountCents: obj.amount_due,
            status: 'open',
            issuedAt: new Date(obj.created * 1000),
          },
          update: { status: 'open' },
        });
      }
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
    } else if (type === 'account.updated') {
      // Fires as a connected business completes/updates their Stripe Connect
      // onboarding (KYC, bank details, etc). This is the authoritative way
      // to learn charges_enabled flipped true — don't rely on the frontend
      // redirect alone, since the user can close the tab mid-flow.
      const business = await prisma.business.findFirst({ where: { stripeConnectedAccountId: obj.id } });
      if (business) {
        await prisma.business.update({
          where: { id: business.id },
          data: {
            stripeChargesEnabled: !!obj.charges_enabled,
            stripePayoutsEnabled: !!obj.payouts_enabled,
            stripeConnectOnboarded: !!obj.details_submitted,
          },
        });
      }
    }
  } catch (e) {
    logger.error('error handling stripe webhook', e);
  }

  res.json({ received: true });
}

module.exports = { handle };