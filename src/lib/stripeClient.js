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
 * Creates a Stripe Connect Express account for a cleaner and returns an
 * onboarding link. Mirrors createConnectAccountAndLink for businesses, with
 * two differences: it's stored on User.stripeConnectedAccountId (a person-
 * level identity — a cleaner working for two businesses shouldn't have to
 * onboard twice, see the schema comment on User), and business_type is
 * 'individual' rather than 'company' since a cleaner is onboarding as
 * themselves, not as a registered business.
 */
async function createCleanerConnectAccountAndLink(user, { refreshUrl, returnUrl } = {}) {
  let accountId = user.stripeConnectedAccountId;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      business_type: 'individual',
      email: user.email,
      individual: {
        email: user.email,
        first_name: user.firstName,
        last_name: user.lastName,
      },
      metadata: { userId: user.id },
    });
    accountId = account.id;
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeConnectedAccountId: accountId },
    });
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl || `${process.env.APP_URL || 'http://localhost:3000'}/cleaner/earnings?stripe=refresh`,
    return_url: returnUrl || `${process.env.APP_URL || 'http://localhost:3000'}/cleaner/earnings?stripe=return`,
    type: 'account_onboarding',
  });

  return { accountId, url: link.url };
}

/**
 * Pays out a cleaner by transferring funds from the *business's* Stripe
 * Connect balance to the cleaner's own connected account.
 *
 * This is deliberately not a transfer from the platform's own balance.
 * Job payments settle on the business's connected account (see
 * createBookingCheckoutSession's transfer_data.destination) — CleanSera's
 * platform account only ever holds the optional application fee, so it has
 * no cleaner-payroll funds to move. Passing { stripeAccount:
 * businessConnectedAccountId } makes Stripe create the Transfer as that
 * connected account, moving money out of *its* balance to the cleaner's
 * connected account — the same "platform-facilitated, connected-account-
 * funded" pattern used for marketplaces paying sub-recipients.
 *
 * Throws a 402 if the business's connected balance can't cover it (Stripe's
 * balance_insufficient), so the caller can surface "insufficient balance,
 * try again once more job payments have settled" instead of a generic 500.
 */
async function payCleanerTransfer({
  businessConnectedAccountId,
  cleanerConnectedAccountId,
  amountCents,
  currency = 'usd',
  payoutId,
  description,
}) {
  if (!process.env.STRIPE_SECRET_KEY) {
    const err = new Error('STRIPE_SECRET_KEY is not configured');
    err.status = 503;
    throw err;
  }
  if (!businessConnectedAccountId) {
    const err = new Error('Business has not completed Stripe Connect onboarding');
    err.status = 402;
    throw err;
  }
  if (!cleanerConnectedAccountId) {
    const err = new Error('Cleaner has not completed Stripe Connect onboarding');
    err.status = 402;
    throw err;
  }
  if (!amountCents || amountCents < 1) {
    const err = new Error('Amount must be greater than 0');
    err.status = 422;
    throw err;
  }

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: amountCents,
        currency: (currency || 'usd').toLowerCase(),
        destination: cleanerConnectedAccountId,
        description: description || `Cleaner payout ${payoutId || ''}`.trim(),
        metadata: { payoutId: payoutId || '' },
      },
      { stripeAccount: businessConnectedAccountId }
    );
    return transfer;
  } catch (err) {
    if (err && err.code === 'balance_insufficient') {
      const wrapped = new Error('Business Stripe balance is insufficient to cover this payout yet');
      wrapped.status = 402;
      throw wrapped;
    }
    throw err;
  }
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
  currency = 'usd',
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
          currency: (currency || 'usd').toLowerCase(),
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

/**
 * Creates a Checkout Session for a one-time charge unrelated to the main
 * job payment — a deposit taken at booking time, or a post-completion tip.
 * Shares the same Connect destination-charge shape as
 * createBookingCheckoutSession (funds settle on the business's connected
 * account, minus an optional platform fee), just parameterized by purpose
 * and amount so callers don't have to duplicate the Stripe call shape.
 */
async function createAncillaryCheckoutSession({
  purpose, // 'deposit' | 'tip'
  bookingId,
  businessId,
  connectedAccountId,
  amountCents,
  currency = 'usd',
  customerEmail,
  successUrl,
  cancelUrl,
  description,
  applyPlatformFee = true,
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

  const applicationFeeAmount = applyPlatformFee ? Math.floor((amountCents * getApplicationFeeBps()) / 10000) : 0;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: (currency || 'usd').toLowerCase(),
          product_data: { name: description || `Cleaning ${purpose} ${bookingId}` },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      transfer_data: { destination: connectedAccountId },
      ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
    },
    customer_email: customerEmail || undefined,
    success_url: successUrl || `${process.env.APP_URL || 'http://localhost:3000'}/portal?payment=success&bookingId=${bookingId}`,
    cancel_url: cancelUrl || `${process.env.APP_URL || 'http://localhost:3000'}/portal?payment=cancelled&bookingId=${bookingId}`,
    metadata: { bookingId, businessId, purpose },
  });

  return session;
}

/**
 * Refunds a prior charge, either fully (amountCents omitted) or partially —
 * partial is what cancellationPolicy.evaluateCancellation asks for when a
 * cancellation fee is owed. Returns null (rather than throwing) when there's
 * no payment intent to refund against, so callers can treat "nothing to
 * refund" as a normal outcome instead of an error path.
 */
async function createRefund({ paymentIntentId, amountCents, reason }) {
  if (!paymentIntentId) return null;
  return stripe.refunds.create({
    payment_intent: paymentIntentId,
    ...(amountCents != null ? { amount: amountCents } : {}),
    reason: reason || 'requested_by_customer',
  });
}

module.exports = {
  createCustomerForBusiness,
  createSubscription,
  cancelSubscription,
  retrieveEvent,
  createConnectAccountAndLink,
  getConnectAccountStatus,
  createCleanerConnectAccountAndLink,
  payCleanerTransfer,
  createBookingCheckoutSession,
  createAncillaryCheckoutSession,
  createRefund,
  stripe,
};
