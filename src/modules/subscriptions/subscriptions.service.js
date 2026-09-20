const prisma = require('../../config/database');
const stripeClient = require('../../lib/stripeClient');

async function listPlans() {
  return prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { monthlyPriceCents: 'asc' },
  });
}

async function getSubscriptionForBusiness(businessId) {
  return prisma.businessSubscription.findUnique({
    where: { businessId },
    include: { plan: true },
  });
}

function conflict(message, status = 409) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Starts (or restarts) a paid subscription by creating a Stripe Checkout
 * session and returning its URL. The subscription row itself is written by
 * the Stripe webhook once Checkout completes, never from client input — the
 * previous implementation trusted client-supplied stripeCustomerId /
 * stripeSubscriptionId and created the row as TRIALING with no payment method.
 */
async function createSubscriptionForBusiness(businessId, { planId } = {}) {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) throw conflict('Subscription plan not found', 422);
  if (!plan.stripePriceId) throw conflict('Subscription plan is missing a Stripe price', 422);

  const existing = await prisma.businessSubscription.findUnique({ where: { businessId } });
  if (existing && existing.status !== 'CANCELED') {
    throw conflict('Business already has a subscription. Change plan or cancel it first.');
  }

  // Only businesses that have never subscribed get a trial.
  const trialDays = existing ? 0 : parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS || '14', 10);

  const owner = await prisma.businessMember.findFirst({
    where: { businessId, role: 'BUSINESS_OWNER', isActive: true },
    include: { user: { select: { email: true } } },
  });

  const session = await stripeClient.createSubscriptionCheckoutSession({
    businessId,
    planId: plan.id,
    priceId: plan.stripePriceId,
    stripeCustomerId: existing ? existing.stripeCustomerId : undefined,
    customerEmail: owner && owner.user ? owner.user.email : undefined,
    trialDays,
  });

  return { checkoutUrl: session.url, sessionId: session.id };
}

/**
 * Changes plan. Only planId is accepted — status, period dates and Stripe ids
 * are owned by Stripe and written by the webhook.
 */
async function updateSubscriptionForBusiness(businessId, { planId } = {}) {
  const sub = await prisma.businessSubscription.findUnique({ where: { businessId }, include: { plan: true } });
  if (!sub) throw conflict('Subscription not found', 404);
  if (!planId) throw conflict('planId is required', 422);
  if (planId === sub.planId) return sub;

  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) throw conflict('Subscription plan not found', 422);

  if (typeof plan.maxCleaners === 'number') {
    const activeCleaners = await prisma.cleanerProfile.count({ where: { businessId, status: 'ACTIVE' } });
    if (activeCleaners > plan.maxCleaners) {
      throw conflict(
        `You have ${activeCleaners} active cleaners, but ${plan.name} allows ${plan.maxCleaners}. Offboard some cleaners first.`
      );
    }
  }

  if (sub.stripeSubscriptionId) {
    await stripeClient.changeSubscriptionPlan(sub.stripeSubscriptionId, plan.stripePriceId);
  }

  return prisma.businessSubscription.update({
    where: { id: sub.id },
    data: { planId: plan.id },
    include: { plan: true },
  });
}

async function cancelSubscriptionForBusiness(businessId) {
  const sub = await prisma.businessSubscription.findUnique({ where: { businessId } });
  if (!sub) return null;

  if (sub.stripeSubscriptionId) {
    try {
      // Effective at the end of the paid period; the webhook flips the row to
      // CANCELED when Stripe actually ends it.
      await stripeClient.cancelSubscriptionAtPeriodEnd(sub.stripeSubscriptionId);
    } catch (e) {
      if (e.code !== 'resource_missing') throw e;
    }
    return prisma.businessSubscription.update({
      where: { id: sub.id },
      data: { canceledAt: new Date() },
      include: { plan: true },
    });
  }

  return prisma.businessSubscription.update({
    where: { id: sub.id },
    data: { status: 'CANCELED', canceledAt: new Date() },
    include: { plan: true },
  });
}

async function createPortalSession(businessId) {
  const sub = await prisma.businessSubscription.findUnique({ where: { businessId } });
  if (!sub || !sub.stripeCustomerId) throw conflict('No billing account yet — subscribe first', 404);
  const session = await stripeClient.createBillingPortalSession(sub.stripeCustomerId);
  return { url: session.url };
}

async function listInvoicesForBusiness(businessId) {
  const sub = await getSubscriptionForBusiness(businessId);
  if (!sub) return [];
  return prisma.platformInvoice.findMany({
    where: { subscriptionId: sub.id },
    orderBy: { issuedAt: 'desc' },
  });
}

module.exports = {
  listPlans,
  getSubscriptionForBusiness,
  createSubscriptionForBusiness,
  updateSubscriptionForBusiness,
  cancelSubscriptionForBusiness,
  createPortalSession,
  listInvoicesForBusiness,
};