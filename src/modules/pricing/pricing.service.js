const prisma = require('../../config/database');

async function getPricing(businessId) {
  let p = await prisma.businessPricing.findUnique({ where: { businessId } });
  if (!p) {
    // return defaults shape
    return { businessId, frequencyDiscounts: null };
  }
  return p;
}

async function updatePricing(businessId, payload) {
  const existing = await prisma.businessPricing.findUnique({ where: { businessId } });
  if (existing) {
    return prisma.businessPricing.update({ where: { businessId }, data: payload });
  }
  return prisma.businessPricing.create({ data: { businessId, ...payload } });
}

async function listCoupons(businessId) {
  return prisma.coupon.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
}

async function createCoupon(businessId, payload) {
  return prisma.coupon.create({ data: { businessId, ...payload } });
}

async function updateCoupon(businessId, id, payload) {
  const c = await prisma.coupon.findFirst({ where: { id, businessId } });
  if (!c) {
    const err = new Error('Coupon not found'); err.status = 404; throw err;
  }
  return prisma.coupon.update({ where: { id }, data: payload });
}

async function deleteCoupon(businessId, id) {
  const c = await prisma.coupon.findFirst({ where: { id, businessId } });
  if (!c) {
    const err = new Error('Coupon not found'); err.status = 404; throw err;
  }
  // soft-delete: deactivate
  return prisma.coupon.update({ where: { id }, data: { isActive: false } });
}

module.exports = { getPricing, updatePricing, listCoupons, createCoupon, updateCoupon, deleteCoupon };
