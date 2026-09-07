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

function calculateQuote(service, payload = {}) {
  const { addOnIds = [], frequency } = payload;
  const { base, estimatedMinutes: baseMinutes } = calculateBase(service, payload);
  const { addOnTotal, extraMinutes } = sumAddOnData(service, addOnIds);

  const estimatedMinutes = baseMinutes + extraMinutes;

  let total = Math.max(0, base + addOnTotal);
  total = applyFrequencyDiscount(total, frequency);

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
