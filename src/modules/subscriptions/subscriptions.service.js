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

async function createSubscriptionForBusiness(
    businessId,
    { planId, stripeCustomerId, stripeSubscriptionId, billingEmail, billingPhone }
) {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) {
    const err = new Error('Subscription plan not found');
    err.status = 422;
    throw err;
  }

  // One subscription per business
  const existing = await prisma.businessSubscription.findUnique({ where: { businessId } });
  if (existing && existing.status !== 'CANCELED') {
    const err = new Error('Business already has an active subscription. Cancel it first or update the plan.');
    err.status = 409;
    throw err;
  }

  let stripeCid = stripeCustomerId;
  if (!stripeCid) {
    stripeCid = await stripeClient.createCustomerForBusiness(businessId, {
      email: billingEmail,
      phone: billingPhone,
    });
  }

  let stripeSubId = stripeSubscriptionId;
  if (!stripeSubId) {
    if (!plan.stripePriceId) {
      const err = new Error('Subscription plan is missing a Stripe price');
      err.status = 422;
      throw err;
    }
    const stripeSub = await stripeClient.createSubscription(stripeCid, plan.stripePriceId);
    stripeSubId = stripeSub.id;
  }

  // If a canceled row exists, reuse/update it; otherwise create
  if (existing) {
    return prisma.businessSubscription.update({
      where: { id: existing.id },
      data: {
        planId,
        stripeCustomerId: stripeCid,
        stripeSubscriptionId: stripeSubId,
        status: 'TRIALING',
        canceledAt: null,
        trialEndsAt: null,
        currentPeriodEnd: null,
      },
      include: { plan: true },
    });
  }

  return prisma.businessSubscription.create({
    data: {
      businessId,
      planId,
      stripeCustomerId: stripeCid,
      stripeSubscriptionId: stripeSubId,
      status: 'TRIALING',
    },
    include: { plan: true },
  });
}

async function updateSubscriptionForBusiness(businessId, patch) {
  const sub = await prisma.businessSubscription.findUnique({ where: { businessId } });
  if (!sub) {
    const err = new Error('Subscription not found');
    err.status = 404;
    throw err;
  }
  return prisma.businessSubscription.update({
    where: { id: sub.id },
    data: patch,
    include: { plan: true },
  });
}

async function cancelSubscriptionForBusiness(businessId) {
  const sub = await prisma.businessSubscription.findUnique({ where: { businessId } });
  if (!sub) return null;

  if (sub.stripeSubscriptionId) {
    try {
      await stripeClient.cancelSubscription(sub.stripeSubscriptionId);
    } catch (e) {
      if (e.code !== 'resource_missing') throw e;
    }
  }

  return prisma.businessSubscription.update({
    where: { id: sub.id },
    data: { status: 'CANCELED', canceledAt: new Date() },
    include: { plan: true },
  });
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
  listInvoicesForBusiness,
};