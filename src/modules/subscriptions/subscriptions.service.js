const prisma = require('../../config/database');

async function getSubscriptionForBusiness(businessId) {
  return prisma.businessSubscription.findUnique({ where: { businessId }, include: { plan: true } });
}

module.exports = { getSubscriptionForBusiness };

const stripeClient = require('../../lib/stripeClient');

async function createSubscriptionForBusiness(businessId, { planId, stripeCustomerId, stripeSubscriptionId, billingEmail, billingPhone }) {
  // if no stripeCustomerId provided, create one
  let stripeCid = stripeCustomerId;
  if (!stripeCid) {
    try {
      stripeCid = await stripeClient.createCustomerForBusiness(businessId, { email: billingEmail, phone: billingPhone });
    } catch (e) {
      // log and continue — DB record won't have stripe ids
    }
  }

  // create Stripe subscription if we have a customer and the plan exists
  let stripeSubId = stripeSubscriptionId;
  try {
    if (stripeCid && planId) {
      const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
      if (plan && plan.stripePriceId) {
        const stripeSub = await stripeClient.createSubscription(stripeCid, plan.stripePriceId);
        stripeSubId = stripeSub.id;
      }
    }
  } catch (e) {
    // ignore stripe failures for now
  }

  const created = await prisma.businessSubscription.create({ data: { businessId, planId, stripeCustomerId: stripeCid, stripeSubscriptionId: stripeSubId, status: 'ACTIVE' } });
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
  await prisma.businessSubscription.update({ where: { id: sub.id }, data: { status: 'CANCELED', canceledAt: new Date() } });
}

module.exports = { getSubscriptionForBusiness, createSubscriptionForBusiness, updateSubscriptionForBusiness, cancelSubscriptionForBusiness };
