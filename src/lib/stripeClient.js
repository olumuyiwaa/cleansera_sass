const Stripe = require('stripe');
const prisma = require('../config/database');
const logger = require('../config/logger');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2022-11-15' });

async function createCustomerForBusiness(businessId, { email, phone } = {}) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { members: { where: { role: 'BUSINESS_OWNER' }, take: 1, include: { user: true } } },
  });
  const ownerEmail =
    email ||
    (business && business.members && business.members[0] && business.members[0].user && business.members[0].user.email) ||
    undefined;

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

/**
 * Create a one-time Checkout Session for a booking.
 * Platform collects on behalf of the business for Phase A (no Connect yet).
 * metadata.bookingId is used by the webhook to mark the booking PAID.
 */
async function createBookingCheckoutSession({
  bookingId,
  businessId,
  amountCents,
  currency = 'ngn',
  customerEmail,
  successUrl,
  cancelUrl,
  description,
}) {
  if (!process.env.STRIPE_SECRET_KEY) {
    const err = new Error('STRIPE_SECRET_KEY is not configured');
    err.status = 503;
    throw err;
  }
  if (!amountCents || amountCents < 50) {
    const err = new Error('Amount must be at least 50 minor units');
    err.status = 422;
    throw err;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: (currency || 'ngn').toLowerCase(),
          product_data: {
            name: description || `Cleaning booking ${bookingId}`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    customer_email: customerEmail || undefined,
    success_url: successUrl || `${process.env.APP_URL || 'http://localhost:3000'}/portal?payment=success&bookingId=${bookingId}`,
    cancel_url: cancelUrl || `${process.env.APP_URL || 'http://localhost:3000'}/portal?payment=cancelled&bookingId=${bookingId}`,
    metadata: {
      bookingId,
      businessId,
      purpose: 'job_payment',
    },
  });

  return session;
}

module.exports = {
  createCustomerForBusiness,
  createSubscription,
  cancelSubscription,
  retrieveEvent,
  createBookingCheckoutSession,
  stripe,
};
