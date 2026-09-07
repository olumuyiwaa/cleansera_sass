const Stripe = require('stripe');
const prisma = require('../config/database');
const logger = require('../config/logger');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2022-11-15' });

async function createCustomerForBusiness(businessId, { email, phone } = {}) {
  // Create stripe customer and return id
  const business = await prisma.business.findUnique({ where: { id: businessId }, include: { members: { where: { role: 'BUSINESS_OWNER' }, take: 1, include: { user: true } } } });
  const ownerEmail = email || (business && business.members && business.members[0] && business.members[0].user && business.members[0].user.email) || undefined;

  const customer = await stripe.customers.create({ email: ownerEmail, phone });
  return customer.id;
}

async function createSubscription(stripeCustomerId, priceId) {
  const sub = await stripe.subscriptions.create({
    customer: stripeCustomerId,
    items: [{ price: priceId }],
    expand: ['latest_invoice.payment_intent'],
  });
  return sub;
}

async function cancelSubscription(stripeSubscriptionId) {
  return stripe.subscriptions.cancel(stripeSubscriptionId);
}

async function retrieveEvent(rawBody, sig) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) return null;
  try {
    return stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error('stripe webhook verification failed', err);
    throw err;
  }
}

module.exports = { createCustomerForBusiness, createSubscription, cancelSubscription, retrieveEvent, stripe };
