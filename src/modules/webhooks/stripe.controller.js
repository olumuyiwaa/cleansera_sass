const { retrieveEvent } = require('../../lib/stripeClient');
const prisma = require('../../config/database');
const logger = require('../../config/logger');

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
      await prisma.businessSubscription.updateMany({ where: { stripeSubscriptionId: stripeSubId }, data: { status: 'ACTIVE', currentPeriodEnd: new Date(obj.lines.data[0].period.end * 1000) } });
    } else if (type === 'invoice.payment_failed') {
      const stripeSubId = obj.subscription;
      await prisma.businessSubscription.updateMany({ where: { stripeSubscriptionId: stripeSubId }, data: { status: 'PAST_DUE' } });
    } else if (type === 'customer.subscription.deleted') {
      const stripeSubId = obj.id;
      await prisma.businessSubscription.updateMany({ where: { stripeSubscriptionId: stripeSubId }, data: { status: 'CANCELED', canceledAt: new Date() } });
    } else if (type === 'customer.subscription.updated') {
      const stripeSubId = obj.id;
      const status = obj.status === 'active' ? 'ACTIVE' : obj.status.toUpperCase();
      await prisma.businessSubscription.updateMany({ where: { stripeSubscriptionId: stripeSubId }, data: { status, currentPeriodEnd: new Date(obj.current_period_end * 1000) } });
    }
  } catch (e) {
    logger.error('error handling stripe webhook', e);
  }

  res.json({ received: true });
}

module.exports = { handle };
