const prisma = require('../../config/database');

async function getSubscriptionForBusiness(businessId) {
  return prisma.businessSubscription.findUnique({ where: { businessId }, include: { plan: true } });
}

module.exports = { getSubscriptionForBusiness };

async function createSubscriptionForBusiness(businessId, { planId, stripeCustomerId, stripeSubscriptionId }) {
  const created = await prisma.businessSubscription.create({ data: { businessId, planId, stripeCustomerId, stripeSubscriptionId, status: 'ACTIVE' } });
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
