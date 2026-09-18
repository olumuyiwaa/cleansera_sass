const prisma = require('../../config/database');
const { isWithinServiceAreas } = require('../../utils/geo');
const { createAncillaryCheckoutSession } = require('../../lib/stripeClient');
const { toPublicBranding } = require('../../lib/branding');

/**
 * Creates the deposit Checkout Session for a freshly-created booking, when
 * the business has a deposit policy configured and enough is charged to
 * clear Stripe's minimum. Stores the session id on the booking and returns
 * its checkout URL so the widget can redirect the customer to pay before
 * the booking is treated as confirmed. Returns null (not an error) when no
 * deposit is required, or when the business hasn't finished Stripe Connect
 * onboarding — a booking should still succeed even if card collection
 * isn't available yet; it just stays payable manually.
 */
async function maybeCreateDepositSession(businessId, booking) {
  const pricing = require('../../lib/pricing');
  const depositRequiredCents = await pricing.computeDepositCents(businessId, booking.quotedPriceCents);
  if (!depositRequiredCents || depositRequiredCents < 50) return null;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { stripeConnectedAccountId: true, stripeChargesEnabled: true },
  });
  if (!business?.stripeChargesEnabled || !business?.stripeConnectedAccountId) return null;

  const customer = await prisma.customer.findUnique({ where: { id: booking.customerId } });

  const session = await createAncillaryCheckoutSession({
    purpose: 'deposit',
    bookingId: booking.id,
    businessId,
    connectedAccountId: business.stripeConnectedAccountId,
    amountCents: depositRequiredCents,
    customerEmail: customer?.email || undefined,
    description: `Deposit for booking ${booking.id}`,
  });

  await prisma.booking.update({
    where: { id: booking.id },
    data: { depositRequiredCents, stripeDepositSessionId: session.id },
  });

  return { url: session.url, sessionId: session.id, depositRequiredCents };
}

/**
 * Public balance check for the widget's "apply a gift card" field —
 * intentionally returns the minimum needed to let the customer confirm a
 * code is real and see what's on it, not the full row (no recipient PII,
 * no purchasedByCustomerId).
 */
async function checkGiftCardBalance(businessId, code) {
  const giftCard = await prisma.giftCard.findFirst({
    where: { businessId, code: String(code || '').toUpperCase(), isActive: true },
  });
  if (!giftCard) return { valid: false, reason: 'not_found' };
  if (!giftCard.purchasePaidAt) return { valid: false, reason: 'not_yet_active' };
  if (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date()) {
    return { valid: false, reason: 'expired' };
  }
  if (giftCard.balanceCents <= 0) return { valid: false, reason: 'zero_balance' };
  return { valid: true, balanceCents: giftCard.balanceCents };
}

/**
 * Redeems a gift card against a just-created booking, best-effort — same
 * "non-fatal, booking still succeeds either way" pattern as
 * maybeCreateDepositSession above. A booking failing because a gift card
 * code had a typo would be a much worse outcome than the booking going
 * through without the discount applied, so callers catch and ignore
 * failures from this rather than letting them fail the whole request.
 *
 * The updateMany's `balanceCents: { gte: appliedCents }` guard is what
 * keeps two near-simultaneous redemptions of the same card from ever
 * pushing its balance negative — one succeeds, the other's updateMany
 * matches zero rows and this returns null rather than double-spending.
 */
async function applyGiftCardToBooking(businessId, booking, giftCardCode) {
  if (!giftCardCode) return null;

  const giftCard = await prisma.giftCard.findFirst({
    where: { businessId, code: String(giftCardCode).toUpperCase(), isActive: true },
  });
  if (!giftCard) return null;
  if (!giftCard.purchasePaidAt) return null;
  if (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date()) return null;
  if (giftCard.balanceCents <= 0) return null;

  const appliedCents = Math.min(giftCard.balanceCents, booking.quotedPriceCents);
  if (appliedCents <= 0) return null;

  const decremented = await prisma.giftCard.updateMany({
    where: { id: giftCard.id, balanceCents: { gte: appliedCents } },
    data: { balanceCents: { decrement: appliedCents } },
  });
  if (decremented.count === 0) return null; // lost the race — skip, don't double-spend

  await prisma.booking.update({
    where: { id: booking.id },
    data: { giftCardId: giftCard.id, giftCardAppliedCents: appliedCents },
  });

  return { giftCardId: giftCard.id, appliedCents };
}

async function getStorefront(businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { branding: true, hours: true },
  });
  if (business?.branding) {
    // This is the fix for a real bug: the frontend's widget/site pages
    // have been reading business.branding.logoUrl (and now also expect
    // heroImageUrl/galleryImageUrls) all along, but nothing here ever
    // populated those fields — only the raw *Key columns came through, so
    // no business's logo has actually rendered on their public site.
    business.branding = toPublicBranding(business.branding);
  }
  const services = await prisma.service.findMany({
    where: { businessId, isActive: true },
    include: { addOns: true },
  });
  const areaCount = await prisma.serviceArea.count({ where: { businessId } });
  // Soft signal only — the widget stays fully loadable either way so a
  // business mid-setup can still preview it, but the frontend uses this to
  // show a "not yet accepting online bookings" state instead of a booking
  // form with no services/areas to actually select.
  const onboardingComplete = services.length > 0 && business?.hours?.length > 0 && areaCount > 0;
  return { business, services, onboardingComplete };
}

async function quote(businessId, {
  serviceId,
  addOnIds = [],
  latitude,
  longitude,
  scheduledStart,
  couponCode,
  giftCardCode,
  rooms,
  bathrooms,
  sqft,
  frequency,
} = {}) {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, businessId, isActive: true },
    include: { addOns: true },
  });
  if (!service) {
    const err = new Error('Service not found');
    err.status = 404;
    throw err;
  }

  if (latitude != null && longitude != null) {
    const areas = await prisma.serviceArea.findMany({ where: { businessId } });
    if (areas.length && !isWithinServiceAreas(latitude, longitude, areas)) {
      const err = new Error("This address is outside the business's service area");
      err.status = 422;
      throw err;
    }
  }

  const pricing = require('../../lib/pricing');
  const quote = await pricing.calculateQuote(service, {
    businessId,
    addOnIds,
    scheduledStart,
    couponCode,
    giftCardCode,
    rooms,
    bathrooms,
    sqft,
    frequency,
  });

  if (scheduledStart) {
    const start = new Date(scheduledStart);
    const end = new Date(start.getTime() + (quote.breakdown.estimatedMinutes || 60) * 60 * 1000);
    const scheduler = require('../../lib/scheduler');
    const candidates = await scheduler.findAvailableCleaners(businessId, start, end, {
      lat: latitude,
      lng: longitude,
    });
    if (!candidates || candidates.length === 0) {
      const err = new Error('No cleaners available for the requested scheduledStart');
      err.status = 422;
      throw err;
    }
  }

  const { computeDepositCents } = pricing;
  const depositRequiredCents = await computeDepositCents(businessId, quote.priceCents);

  return {
    serviceId,
    addOnIds,
    priceCents: quote.priceCents,
    estimatedMinutes: quote.breakdown.estimatedMinutes,
    breakdown: quote.breakdown,
    coupon: quote.coupon,
    giftCard: quote.giftCard,
    depositRequiredCents: depositRequiredCents || 0,
  };
}

/**
 * Creates the customer record (find-or-create, scoped to this business) and
 * the booking in one go — the widget's main conversion action.
 */
async function submitBooking(businessId, payload) {
  const {
    firstName, lastName, email, phone,
    addressLine1, addressLine2, city, state, latitude, longitude,
    accessCode, keyLocation, parkingInstructions, petNotes, specialInstructions,
    serviceId, addOnIds = [], scheduledStart,
    couponCode, giftCardCode, referralCode,
  } = payload;

  const { priceCents, estimatedMinutes, coupon: couponInfo } = await quote(businessId, { serviceId, addOnIds, latitude, longitude, scheduledStart, couponCode, giftCardCode });

  // availability: ensure at least one cleaner can cover the requested window
  if (scheduledStart) {
    const start = new Date(scheduledStart);
    const end = new Date(start.getTime() + estimatedMinutes * 60 * 1000);
    const scheduler = require('../../lib/scheduler');
    const candidates = await scheduler.findAvailableCleaners(businessId, start, end, { lat: latitude, lng: longitude });
    if (!candidates || candidates.length === 0) {
      const err = new Error('No cleaners available for the selected time');
      err.status = 422;
      throw err;
    }
  }

  // handle booking + coupon redemption atomically when couponCode provided
  const start = new Date(scheduledStart);
  const end = new Date(start.getTime() + estimatedMinutes * 60 * 1000);

  if (couponCode) {
    const coupon = await prisma.coupon.findFirst({ where: { businessId, code: couponCode, isActive: true } });
    if (!coupon) { const err = new Error('Coupon not found'); err.status = 422; throw err; }
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) { const err = new Error('Coupon expired'); err.status = 422; throw err; }
    if (coupon.appliesToServiceId && coupon.appliesToServiceId !== serviceId) { const err = new Error('Coupon not applicable to this service'); err.status = 422; throw err; }

    const result = await prisma.$transaction(async (tx) => {
      const cust = await tx.customer.upsert({ where: { businessId_phone: { businessId, phone } }, update: { firstName, lastName, email }, create: { businessId, firstName, lastName, email, phone } });

      if (coupon.perCustomerLimit) {
        const used = await tx.booking.count({ where: { customerId: cust.id, couponId: coupon.id } });
        if (used >= coupon.perCustomerLimit) { const err = new Error('Coupon per-customer redemption limit reached'); err.status = 422; throw err; }
      }

      const b = await tx.booking.create({ data: { businessId, customerId: cust.id, serviceId, addressLine1, addressLine2, city, state, latitude, longitude, accessCode, keyLocation, parkingInstructions, petNotes, specialInstructions, scheduledStart: start, scheduledEnd: end, quotedPriceCents: priceCents, status: 'REQUESTED', couponId: coupon.id } });

      if (coupon.maxRedemptions) {
        const updated = await tx.coupon.updateMany({ where: { id: coupon.id, redeemedCount: { lt: coupon.maxRedemptions } }, data: { redeemedCount: { increment: 1 } } });
        if (updated.count === 0) { const err = new Error('Coupon redemption limit reached'); err.status = 409; throw err; }
      } else {
        await tx.coupon.update({ where: { id: coupon.id }, data: { redeemedCount: { increment: 1 } } });
      }

      return { booking: b, customer: cust };
    });

    const booking = result.booking;
    const customer = result.customer;
    try { const notifications = require('../notifications/notifications.service'); await notifications.notifyBookingCreated(businessId, booking); await notifications.sendCustomerBookingConfirmation(businessId, booking, customer); } catch (e) {}
    let deposit = null;
    try { deposit = await maybeCreateDepositSession(businessId, booking); } catch (e) { /* non-fatal — booking still succeeds without card collection */ }
    let giftCard = null;
    try { giftCard = await applyGiftCardToBooking(businessId, booking, giftCardCode); } catch (e) { /* non-fatal — booking still succeeds without the gift card applied */ }
    return { ...booking, deposit, giftCard };
  }

  // Referral program (only when no manual coupon was applied — the two
  // discounts aren't designed to stack, to keep the pricing math and the
  // reward-issuing logic below from getting tangled with coupon redemption
  // limits).
  const REFERRAL_DISCOUNT_CENTS = 1000; // new customer gets $10 off
  const REFERRAL_REWARD_CENTS = 1000; // referrer gets a $10-off coupon for next time

  const existingCustomer = await prisma.customer.findFirst({ where: { businessId, phone } });
  let referrer = null;
  if (referralCode && !existingCustomer) {
    referrer = await prisma.customer.findFirst({ where: { businessId, referralCode: referralCode.toUpperCase() } });
  }
  const referralDiscountCents = referrer ? Math.min(REFERRAL_DISCOUNT_CENTS, priceCents) : 0;
  const finalPriceCents = priceCents - referralDiscountCents;

  const customer = await prisma.customer.upsert({
    where: { businessId_phone: { businessId, phone } },
    update: { firstName, lastName, email },
    create: { businessId, firstName, lastName, email, phone },
  });
  const customerReferralCode = customer.referralCode || (await require('../customers/customers.service').ensureReferralCode(customer.id));

  const booking = await prisma.booking.create({
    data: {
      businessId,
      customerId: customer.id,
      serviceId,
      addressLine1,
      addressLine2,
      city,
      state,
      latitude,
      longitude,
      accessCode,
      keyLocation,
      parkingInstructions,
      petNotes,
      specialInstructions,
      scheduledStart: start,
      scheduledEnd: end,
      quotedPriceCents: finalPriceCents,
      status: 'REQUESTED',
      referredByCustomerId: referrer?.id || null,
    },
  });

  // Notify business dashboard (Socket.io) + confirmation email/SMS to customer
  try {
    const notifications = require('../notifications/notifications.service');
    await notifications.notifyBookingCreated(businessId, booking);
    await notifications.sendCustomerBookingConfirmation(businessId, booking, customer);
  } catch (e) {
    // non-fatal
  }

  // Reward the referrer with a single-use coupon, delivered only to them via
  // SMS/email — there's no per-customer scoping column on Coupon, so a
  // freshly generated, only-shared-with-them code is what keeps this
  // effectively "theirs" rather than a code anyone could guess and use.
  if (referrer) {
    try {
      const rewardCode = `REF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await prisma.coupon.create({
        data: {
          businessId,
          code: rewardCode,
          type: 'AMOUNT',
          value: REFERRAL_REWARD_CENTS,
          maxRedemptions: 1,
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        },
      });
      const notificationClient = require('../../lib/notificationClient');
      const business = await prisma.business.findUnique({ where: { id: businessId } });
      const rewardMsg = `${business.name}: thanks for the referral! Use code ${rewardCode} for $10 off your next booking.`;
      if (referrer.phone) await notificationClient.sendSms({ to: referrer.phone, body: rewardMsg });
      if (referrer.email) await notificationClient.sendEmail({ to: referrer.email, subject: `${business.name}: your referral reward`, text: rewardMsg, html: `<p>${rewardMsg}</p>` });
    } catch (e) {
      // non-fatal — the referred customer's discount already applied regardless
    }
  }

  let deposit = null;
  try { deposit = await maybeCreateDepositSession(businessId, booking); } catch (e) { /* non-fatal */ }
  let giftCard = null;
  try { giftCard = await applyGiftCardToBooking(businessId, booking, giftCardCode); } catch (e) { /* non-fatal — booking still succeeds without the gift card applied */ }
  return { ...booking, deposit, giftCard, referralCode: customerReferralCode, referralDiscountCents };
}

module.exports = {
  getStorefront,
  quote,
  submitBooking,
  maybeCreateDepositSession,
  checkGiftCardBalance,
  applyGiftCardToBooking,
};

/**
 * Return available time slots for a given date and service. Query: ?serviceId=&date=YYYY-MM-DD&slotMinutes=&startHour=&endHour=&limit=
 */
async function slots(businessId, query) {
  const { serviceId, date, slotMinutes = 60, startHour, endHour, limit = 20 } = query;
  if (!serviceId) {
    const err = new Error('serviceId is required');
    err.status = 422;
    throw err;
  }
  const svc = await prisma.service.findFirst({ where: { id: serviceId, businessId, isActive: true }, include: { addOns: true } });
  if (!svc) {
    const err = new Error('Service not found');
    err.status = 404;
    throw err;
  }

  const day = date ? new Date(date + 'T00:00:00') : new Date();
  const businessHours = await prisma.businessHours.findMany({ where: { businessId, dayOfWeek: day.getDay() } });

  const slotLen = parseInt(slotMinutes, 10) || svc.estimatedMinutes || 60;
  const slots = [];
  const scheduler = require('../../lib/scheduler');
  // simple per-request cache to avoid repeated scheduler queries for identical slot windows
  const _availCache = new Map();
  const cache = require('../../lib/cache');

  // try Redis cache for the whole day/service if available
  const redisKey = `slots:${businessId}:${serviceId}:${day.toISOString().slice(0,10)}:${slotLen}`;
  const cached = await cache.get(redisKey);
  if (cached) return { date: day.toISOString().slice(0, 10), slots: cached };

  for (const h of businessHours) {
    const startParts = h.openTime.split(':').map(Number);
    const endParts = h.closeTime.split(':').map(Number);
    const startDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startParts[0], startParts[1] || 0);
    const endDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endParts[0], endParts[1] || 0);

    for (let t = new Date(startDt); t.getTime() + slotLen * 60000 <= endDt.getTime(); t.setMinutes(t.getMinutes() + 30)) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t.getTime() + slotLen * 60000);
      const cacheKey = slotStart.toISOString() + '|' + slotEnd.toISOString();
      let candidates = _availCache.get(cacheKey);
      if (typeof candidates === 'undefined') {
        candidates = await scheduler.findAvailableCleaners(businessId, slotStart, slotEnd, {});
        _availCache.set(cacheKey, candidates || []);
      }
      if (candidates && candidates.length > 0) {
        slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString(), available: candidates.length });
      }
      if (slots.length >= limit) break;
    }
    if (slots.length >= limit) break;
  }

  // store in Redis short-term cache
  try { await cache.set(redisKey, slots, 30); } catch (e) { }

  return { date: day.toISOString().slice(0, 10), slots };
}

module.exports.slots = slots;
