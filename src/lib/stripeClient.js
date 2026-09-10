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
 * Platform fee taken on each job-level payment, in basis points (1/100 of a
 * percent). 150 = 1.5%. Configurable per deployment; falls back to 0 (pure
 * pass-through) if unset, which is a valid choice if the fee is instead
 * folded into the subscription plan price.
 */
function getApplicationFeeBps() {
  const raw = process.env.PLATFORM_APPLICATION_FEE_BPS;
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Creates a Stripe Connect Express account for a business and returns an
 * onboarding link. Express accounts push most compliance/KYC UI onto
 * Stripe's hosted flow, which is the right tradeoff for a platform this
 * size — we don't want to own identity verification.
 */
async function createConnectAccountAndLink(business, { refreshUrl, returnUrl }) {
  let accountId = business.stripeConnectedAccountId;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      business_type: 'company',
      business_profile: {
        name: business.name,
        url: business.customDomain ? `https://${business.customDomain}` : undefined,
      },
      metadata: { businessId: business.id },
    });
    accountId = account.id;
    await prisma.business.update({
      where: { id: business.id },
      data: { stripeConnectedAccountId: accountId },
    });
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl || `${process.env.APP_URL || 'http://localhost:3000'}/business-settings?stripe=refresh`,
    return_url: returnUrl || `${process.env.APP_URL || 'http://localhost:3000'}/business-settings?stripe=return`,
    type: 'account_onboarding',
  });

  return { accountId, url: link.url };
}

/** Pulls current charges_enabled/payouts_enabled/details_submitted from Stripe for a connected account. */
async function getConnectAccountStatus(accountId) {
  const account = await stripe.accounts.retrieve(accountId);
  return {
    chargesEnabled: !!account.charges_enabled,
    payoutsEnabled: !!account.payouts_enabled,
    detailsSubmitted: !!account.details_submitted,
  };
}

/**
 * Create a one-time Checkout Session for a booking, using Stripe Connect
 * destination charges: the customer's payment settles on the platform
 * account only in transit — funds are transferred to the business's
 * connected account (transfer_data.destination) minus an optional platform
 * application fee. CleanSera never holds job-payment funds; it only ever
 * collects application_fee_amount, the same as the subscription fee model.
 * metadata.bookingId is used by the webhook to mark the booking PAID.
 */
async function createBookingCheckoutSession({
  bookingId,
  businessId,
  connectedAccountId,
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
  if (!connectedAccountId) {
    const err = new Error('Business has not completed Stripe Connect onboarding');
    err.status = 402;
    throw err;
  }
  if (!amountCents || amountCents < 50) {
    const err = new Error('Amount must be at least 50 minor units');
    err.status = 422;
    throw err;
  }

  const applicationFeeAmount = Math.floor((amountCents * getApplicationFeeBps()) / 10000);

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
    payment_intent_data: {
      transfer_data: { destination: connectedAccountId },
      // Omit entirely when 0 so a $0-fee deployment doesn't send a
      // meaningless application_fee_amount: 0 to Stripe.
      ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
    },
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
  createConnectAccountAndLink,
  getConnectAccountStatus,
  createBookingCheckoutSession,
  stripe,
};
