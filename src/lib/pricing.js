const prisma = require('../config/database');
const DEFAULTS = {
  perSqftCents: 10, // 10 cents per sqft
  perRoomCents: 1500, // $15 per room
  hourlyMultiplier: 1, // basePriceCents treated as hourly rate
  frequencyDiscounts: { WEEKLY: 0.10, BIWEEKLY: 0.05, MONTHLY: 0.0 },
};

function sumAddOnData(service, selectedAddOnIds = []) {
  if (!service || !service.addOns) return { addOnTotal: 0, extraMinutes: 0 };
  const selected = service.addOns.filter(a => selectedAddOnIds.includes(a.id));
  const addOnTotal = selected.reduce((s, a) => s + (a.priceCents || 0), 0);
  const extraMinutes = selected.reduce((s, a) => s + (a.extraMinutes || 0), 0);
  return { addOnTotal, extraMinutes };
}

function calculateBase(service, { sqft, rooms, bathrooms, customDurationMinutes } = {}) {
  const model = service.pricingModel || 'FLAT';
  let base = service.basePriceCents || 0;
  let estimatedMinutes = service.estimatedMinutes || 60;

  if (model === 'PER_SQFT') {
    const per = DEFAULTS.perSqftCents;
    base = Math.round((service.basePriceCents || 0) + (Number(sqft || 0) * per));
  } else if (model === 'PER_ROOM') {
    const per = DEFAULTS.perRoomCents;
    base = Math.round((service.basePriceCents || 0) + (Number(rooms || 0) * per));
  } else if (model === 'HOURLY') {
    const hourly = service.basePriceCents || 0; // treat base as hourly rate
    const minutes = Number(customDurationMinutes || service.estimatedMinutes || 60);
    base = Math.round((hourly / 60) * minutes);
    estimatedMinutes = minutes;
  } else {
    // FLAT
    base = service.basePriceCents || 0;
  }

  return { base, estimatedMinutes };
}

function applyFrequencyDiscount(priceCents, frequency) {
  if (!frequency) return priceCents;
  const disc = DEFAULTS.frequencyDiscounts[frequency] || 0;
  return Math.round(priceCents * (1 - disc));
}

async function calculateQuote(service, payload = {}) {
  const { businessId, addOnIds = [], frequency, couponCode } = payload;
  const { base, estimatedMinutes: baseMinutes } = calculateBase(service, payload);
  const { addOnTotal, extraMinutes } = sumAddOnData(service, addOnIds);

  const estimatedMinutes = baseMinutes + extraMinutes;

  let total = Math.max(0, base + addOnTotal);

  // apply business-configured frequency discounts when available
  let freqDisc = DEFAULTS.frequencyDiscounts;
  if (businessId) {
    try {
      const bp = await prisma.businessPricing.findUnique({ where: { businessId } });
      if (bp && bp.frequencyDiscounts) {
        const parsed = typeof bp.frequencyDiscounts === 'string' ? JSON.parse(bp.frequencyDiscounts) : bp.frequencyDiscounts;
        freqDisc = Object.assign({}, DEFAULTS.frequencyDiscounts, parsed || {});
      }
    } catch (e) {
      // ignore DB errors and fallback to defaults
    }
  }

  if (frequency) {
    const disc = (freqDisc && freqDisc[frequency]) || 0;
    total = Math.round(total * (1 - disc));
  }

  // apply coupon if provided
  if (businessId && couponCode) {
    try {
      const coupon = await prisma.coupon.findFirst({ where: { businessId, code: couponCode, isActive: true } });
      if (coupon) {
        if (coupon.type === 'PERCENT') {
          total = Math.round(total * (1 - (coupon.value || 0) / 100));
        } else if (coupon.type === 'AMOUNT') {
          total = Math.max(0, total - (coupon.value || 0));
        }
      }
    } catch (e) {
      // ignore coupon lookup failures
    }
  }

  const breakdown = {
    base,
    addOnTotal,
    frequency: frequency || null,
    total,
    estimatedMinutes,
  };

  return { priceCents: total, breakdown };
}

module.exports = { calculateQuote };
