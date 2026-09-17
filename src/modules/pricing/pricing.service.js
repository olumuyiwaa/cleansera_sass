const prisma = require('../../config/database');

async function getPricing(businessId) {
  let p = await prisma.businessPricing.findUnique({ where: { businessId } });
  if (!p) {
    // return defaults shape — perSqftCents/perRoomCents null here means
    // "not set", which lib/pricing.js reads as "use the platform DEFAULTS"
    return { businessId, frequencyDiscounts: null, perSqftCents: null, perRoomCents: null };
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

function generateGiftCardCode() {
  return `GC-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

async function listGiftCards(businessId) {
  return prisma.giftCard.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
}

/**
 * Business-issued gift card — usable immediately (purchasePaidAt is set to
 * now, since there's no Stripe checkout to wait on here; that's the online
 * "customer buys one through the widget" path, which is a separate,
 * not-yet-built flow — see the note in widget.service.js).
 */
async function issueGiftCard(businessId, {
  code,
  initialValueCents,
  recipientEmail,
  recipientName,
  message,
  expiresAt,
} = {}) {
  if (!initialValueCents || initialValueCents < 1) {
    const err = new Error('initialValueCents must be greater than 0'); err.status = 422; throw err;
  }
  const finalCode = (code || generateGiftCardCode()).toUpperCase();
  const existing = await prisma.giftCard.findUnique({ where: { businessId_code: { businessId, code: finalCode } } });
  if (existing) {
    const err = new Error('A gift card with this code already exists'); err.status = 409; throw err;
  }
  return prisma.giftCard.create({
    data: {
      businessId,
      code: finalCode,
      initialValueCents,
      balanceCents: initialValueCents,
      recipientEmail: recipientEmail || null,
      recipientName: recipientName || null,
      message: message || null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      purchasePaidAt: new Date(),
    },
  });
}

async function deactivateGiftCard(businessId, id) {
  const gc = await prisma.giftCard.findFirst({ where: { id, businessId } });
  if (!gc) {
    const err = new Error('Gift card not found'); err.status = 404; throw err;
  }
  return prisma.giftCard.update({ where: { id }, data: { isActive: false } });
}

module.exports = {
  getPricing,
  updatePricing,
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  listGiftCards,
  issueGiftCard,
  deactivateGiftCard,
};
