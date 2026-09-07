const prisma = require('../../config/database');

async function getSubscriptionForBusiness(businessId) {
  return prisma.businessSubscription.findUnique({ where: { businessId }, include: { plan: true } });
}

module.exports = { getSubscriptionForBusiness };

const stripeClient = require('../../lib/stripeClient');

async function createSubscriptionForBusiness(businessId, { planId, stripeCustomerId, stripeSubscriptionId, billingEmail, billingPhone }) {
  // Validate the plan up front regardless of which branch below runs — an
  // invalid planId shouldn't slip through just because both Stripe IDs were
  // already supplied.
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) {
    const err = new Error('Subscription plan not found');
    err.status = 422;
    throw err;
  }

  // if no stripeCustomerId provided, create one — this must succeed, since a
  // subscription with no real Stripe customer behind it can never be billed
  // or corrected by a webhook later.
  let stripeCid = stripeCustomerId;
  if (!stripeCid) {
    stripeCid = await stripeClient.createCustomerForBusiness(businessId, { email: billingEmail, phone: billingPhone });
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

  // Status starts TRIALING/incomplete here regardless — the webhook handler
  // (invoice.payment_succeeded / customer.subscription.updated) is the only
  // place that should ever flip a subscription to ACTIVE, once Stripe
  // confirms payment actually went through.
  const created = await prisma.businessSubscription.create({
    data: { businessId, planId, stripeCustomerId: stripeCid, stripeSubscriptionId: stripeSubId, status: 'TRIALING' },
  });
  return created;
}

async function updateSubscriptionForBusiness(businessId, patch) {
  const sub = await prisma.businessSubscription.findUnique({ where: { businessId } });
  if (!sub) {
    const err = new Error('Subscription not found');
    err.status = 404;
    throw err;
  }
  const updated = await prisma.businessSubscription.update({ where: { id: sub.id }, data: patch });
  return updated;
}

async function cancelSubscriptionForBusiness(businessId) {
  const sub = await prisma.businessSubscription.findUnique({ where: { businessId } });
  if (!sub) return null;

  if (sub.stripeSubscriptionId) {
    try {
      await stripeClient.cancelSubscription(sub.stripeSubscriptionId);
    } catch (e) {
      // If Stripe already considers it canceled (e.g. a race with a webhook),
      // don't block the local cancellation on that; any other failure should
      // surface so the caller knows billing wasn't actually stopped.
      if (e.code !== 'resource_missing') throw e;
    }
  }

  return prisma.businessSubscription.update({ where: { id: sub.id }, data: { status: 'CANCELED', canceledAt: new Date() } });
}

module.exports = { getSubscriptionForBusiness, createSubscriptionForBusiness, updateSubscriptionForBusiness, cancelSubscriptionForBusiness };
