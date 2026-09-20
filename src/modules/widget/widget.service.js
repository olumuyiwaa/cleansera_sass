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
const crypto = require('crypto');
const logger = require('../../config/logger');
const { getZonedParts, zonedWallTimeToUtc, advanceRunDate } = require('../../utils/timezone');
const { geocodeNl } = require('../../lib/geocode');

const SLOT_STEP_MINUTES = 30;
const DEFAULT_MIN_NOTICE_HOURS = 2;
const MAX_SLOTS = 96;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Shortest notice a customer can book with, so nobody books a slot that starts in five minutes. BOOKING_MIN_NOTICE_HOURS overrides. */
function minNoticeMs() {
  const h = Number(process.env.BOOKING_MIN_NOTICE_HOURS);
  return (Number.isFinite(h) && h >= 0 ? h : DEFAULT_MIN_NOTICE_HOURS) * 3600 * 1000;
}

async function getBusinessTimezone(businessId) {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
  return (b && b.timezone) || 'Europe/Amsterdam';
}

function formatMoney(cents, currency) {
  return new Intl.NumberFormat(process.env.DEFAULT_LOCALE || 'nl-NL', {
    style: 'currency',
    currency: String(currency || 'eur').toUpperCase(),
  }).format((cents || 0) / 100);
}

/**
 * How many cleaners can still take a job in this window. findAvailableCleaners
 * only looks at *assigned* work, so requests that have not been dispatched yet
 * used to be invisible to it and the same slot could be sold to any number of
 * customers. Subtract the overlapping unassigned bookings from the pool.
 */
async function spareCapacity(businessId, start, end, opts = {}) {
  const scheduler = require('../../lib/scheduler');
  const candidates = (await scheduler.findAvailableCleaners(businessId, start, end, opts)) || [];
  const unassigned = await prisma.booking.count({
    where: {
      businessId,
      status: { in: ['REQUESTED', 'CONFIRMED'] },
      assignments: { none: {} },
      scheduledStart: { lt: end },
      scheduledEnd: { gt: start },
    },
  });
  return { candidates, spare: Math.max(0, candidates.length - unassigned) };
}

/**
 * Coordinates for the service-area check. Uses what the form sent; otherwise,
 * only when the business actually restricts its area, looks the address up.
 * Previously the check ran only if the client volunteered latitude/longitude,
 * so omitting them bypassed it.
 */
async function resolveCoordinates(hasAreas, { latitude, longitude, postalCode, addressLine1, city }) {
  if (latitude != null && longitude != null) return { latitude, longitude };
  if (!hasAreas) return { latitude: latitude ?? null, longitude: longitude ?? null };
  const found = await geocodeNl({ postalCode, addressLine1, city });
  if (!found) logger.warn('service-area check skipped: address could not be geocoded', { postalCode });
  return found || { latitude: null, longitude: null };
}

async function maybeCreateDepositSession(businessId, booking) {
  const pricing = require('../../lib/pricing');
  const depositRequiredCents = await pricing.computeDepositCents(businessId, booking.quotedPriceCents);
  if (!depositRequiredCents || depositRequiredCents < 50) return null;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { stripeConnectedAccountId: true, stripeChargesEnabled: true, currency: true },
  });
  if (!business?.stripeChargesEnabled || !business?.stripeConnectedAccountId) return null;

  const customer = await prisma.customer.findUnique({ where: { id: booking.customerId } });

  const session = await createAncillaryCheckoutSession({
    purpose: 'deposit',
    bookingId: booking.id,
    businessId,
    connectedAccountId: business.stripeConnectedAccountId,
    amountCents: depositRequiredCents,
    currency: business.currency,
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

/**
 * Finds or creates the customer for an anonymous booking, keyed by phone.
 *
 * An existing customer is returned untouched. The previous code overwrote
 * firstName/lastName/email from the public form, so anyone who knew a
 * customer's phone number could replace their email with their own and then
 * receive that customer's portal one-time codes. Contact details are only
 * ever changed by the customer through a verified flow or by the business
 * from the dashboard.
 */
async function upsertGuestCustomer(client, businessId, { firstName, lastName, email, phone }) {
  return client.customer.upsert({
    where: { businessId_phone: { businessId, phone } },
    update: {},
    create: { businessId, firstName, lastName, email, phone },
  });
}

async function getStorefront(businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { branding: true, hours: true },
  });
  if (business?.branding) {
    business.branding = toPublicBranding(business.branding);
  }
  const services = await prisma.service.findMany({
    where: { businessId, isActive: true },
    include: { addOns: true },
  });
  const areaCount = await prisma.serviceArea.count({ where: { businessId } });
  const onboardingComplete =
      services.length > 0 && business?.hours?.length > 0 && areaCount > 0;

  const onlineCardReady =
      !!business?.stripeChargesEnabled && !!business?.stripeConnectedAccountId;
  const preferred = business?.preferredPaymentCollection || 'BOTH';
  const canPayByCard =
      onlineCardReady && (preferred === 'ONLINE_CARD' || preferred === 'BOTH');
  const canPayOffline =
      preferred === 'MANUAL_OFFLINE' || preferred === 'BOTH';

  return {
    business,
    services,
    onboardingComplete,
    payment: {
      onlineCardReady: canPayByCard,
      offlineAccepted: canPayOffline,
      offlinePaymentInstructions: business?.offlinePaymentInstructions || null,
    },
  };
}

async function quote(businessId, {
  serviceId,
  addOnIds = [],
  latitude,
  longitude,
  postalCode,
  addressLine1,
  city,
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
  if (!service) throw httpError(404, 'Service not found');

  const areas = await prisma.serviceArea.findMany({ where: { businessId } });
  const coords = await resolveCoordinates(areas.length > 0, { latitude, longitude, postalCode, addressLine1, city });
  if (areas.length && coords.latitude != null && coords.longitude != null
      && !isWithinServiceAreas(coords.latitude, coords.longitude, areas)) {
    throw httpError(422, "This address is outside the business's service area");
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
    if (Number.isNaN(start.getTime())) throw httpError(422, 'scheduledStart is not a valid date');
    if (start.getTime() < Date.now() + minNoticeMs()) {
      const hours = Math.round(minNoticeMs() / 3600000);
      throw httpError(422, `Please choose a time at least ${hours} hour${hours === 1 ? '' : 's'} from now`);
    }
    const end = new Date(start.getTime() + (quote.breakdown.estimatedMinutes || 60) * 60 * 1000);
    const { spare } = await spareCapacity(businessId, start, end, { lat: coords.latitude, lng: coords.longitude });
    if (spare < 1) throw httpError(422, 'No cleaners available for the requested scheduledStart');
  }

  const { computeDepositCents } = pricing;
  const depositRequiredCents = await computeDepositCents(businessId, quote.priceCents);

  const chosen = new Set(addOnIds || []);
  return {
    serviceId,
    addOnIds,
    // Frozen copy of the selected add-ons for the booking record.
    addOns: service.addOns
      .filter((a) => chosen.has(a.id))
      .map((a) => ({ id: a.id, name: a.name, priceCents: a.priceCents, extraMinutes: a.extraMinutes })),
    latitude: coords.latitude,
    longitude: coords.longitude,
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
/**
 * Turns an accepted quote plus the form payload into the booking row. The
 * pricing inputs (rooms, bathrooms, sqft, frequency), add-ons, postcode and
 * the customer's notes used to be dropped here even though the form sent them.
 */
function buildBookingData({ businessId, customerId, serviceId, payload, q, start, end, priceCents, extra = {} }) {
  const {
    addressLine1, addressLine2, city, state, postalCode,
    accessCode, keyLocation, parkingInstructions, petNotes, specialInstructions, notes,
    rooms, bathrooms, sqft, frequency,
  } = payload;

  const homeDetails = Object.fromEntries(
    Object.entries({ rooms, bathrooms, sqft, frequency }).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
  const instructions = [specialInstructions, notes].filter((t) => t && String(t).trim()).join('\n\n');

  return {
    businessId,
    customerId,
    serviceId,
    addressLine1,
    addressLine2,
    city,
    state: state || '',
    postalCode: postalCode || null,
    latitude: q.latitude ?? null,
    longitude: q.longitude ?? null,
    accessCode,
    keyLocation,
    parkingInstructions,
    petNotes,
    specialInstructions: instructions || undefined,
    addOns: q.addOns && q.addOns.length ? q.addOns : undefined,
    homeDetails: Object.keys(homeDetails).length ? homeDetails : undefined,
    scheduledStart: start,
    scheduledEnd: end,
    quotedPriceCents: priceCents,
    status: 'REQUESTED',
    ...extra,
  };
}

/**
 * The customer picked weekly/bi-weekly/monthly and the price already reflects
 * that discount, so there has to be a schedule to honour it. Previously the
 * form's "weekly" produced one single job. This booking is the first
 * occurrence; the schedule's next run is one interval later.
 */
async function maybeCreateRecurringSchedule(businessId, booking, customer, frequency) {
  if (!['WEEKLY', 'BIWEEKLY', 'MONTHLY'].includes(frequency)) return null;
  try {
    const tz = await getBusinessTimezone(businessId);
    const local = getZonedParts(booking.scheduledStart, tz);
    const dayOfWeek = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    const pad = (n) => String(n).padStart(2, '0');
    const startTime = `${pad(local.hour)}:${pad(local.minute)}`;

    const address = await prisma.customerAddress.create({
      data: {
        customerId: customer.id,
        line1: booking.addressLine1,
        line2: booking.addressLine2 || null,
        city: booking.city,
        state: booking.state || '',
        postalCode: booking.postalCode || '',
        latitude: booking.latitude,
        longitude: booking.longitude,
        accessCode: booking.accessCode,
        keyLocation: booking.keyLocation,
        parkingInstructions: booking.parkingInstructions,
        petNotes: booking.petNotes,
      },
    });
    const schedule = await prisma.recurringSchedule.create({
      data: {
        businessId,
        customerId: customer.id,
        serviceId: booking.serviceId,
        customerAddressId: address.id,
        frequency,
        dayOfWeek,
        startTime,
        nextRunDate: advanceRunDate(booking.scheduledStart, frequency, startTime, tz),
      },
    });
    await prisma.booking.update({ where: { id: booking.id }, data: { recurringScheduleId: schedule.id } });
    return schedule;
  } catch (e) {
    logger.error('could not create recurring schedule from widget booking', { bookingId: booking.id, error: e.message });
    return null;
  }
}

/**
 * Creates the customer record (find-or-create, scoped to this business) and
 * the booking in one go — the widget's main conversion action.
 */
async function submitBooking(businessId, payload) {
  const {
    firstName, lastName, email, phone,
    addressLine1, city, postalCode,
    serviceId, addOnIds = [], scheduledStart,
    couponCode, giftCardCode, referralCode,
    rooms, bathrooms, sqft, frequency,
  } = payload;

  // Price using the same inputs the customer saw in the live quote. This call
  // used to omit rooms/bathrooms/sqft/frequency, so per-room and per-sqft
  // services were booked at the base price whatever the quote said.
  const q = await quote(businessId, {
    serviceId, addOnIds, scheduledStart, couponCode, giftCardCode,
    latitude: payload.latitude, longitude: payload.longitude, postalCode, addressLine1, city,
    rooms, bathrooms, sqft, frequency,
  });
  const { priceCents, estimatedMinutes, coupon: couponInfo } = q;
  const start = new Date(scheduledStart);
  const end = new Date(start.getTime() + estimatedMinutes * 60 * 1000);

  // handle booking + coupon redemption atomically when couponCode provided
  if (couponCode) {
    const coupon = await prisma.coupon.findFirst({ where: { businessId, code: couponCode, isActive: true } });
    if (!coupon) throw httpError(422, 'Coupon not found');
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) throw httpError(422, 'Coupon expired');
    if (coupon.appliesToServiceId && coupon.appliesToServiceId !== serviceId) throw httpError(422, 'Coupon not applicable to this service');

    const result = await prisma.$transaction(async (tx) => {
      const cust = await upsertGuestCustomer(tx, businessId, { firstName, lastName, email, phone });

      if (coupon.perCustomerLimit) {
        const used = await tx.booking.count({ where: { customerId: cust.id, couponId: coupon.id } });
        if (used >= coupon.perCustomerLimit) throw httpError(422, 'Coupon per-customer redemption limit reached');
      }

      const b = await tx.booking.create({
        data: buildBookingData({ businessId, customerId: cust.id, serviceId, payload, q, start, end, priceCents, extra: { couponId: coupon.id } }),
      });

      if (coupon.maxRedemptions) {
        const updated = await tx.coupon.updateMany({ where: { id: coupon.id, redeemedCount: { lt: coupon.maxRedemptions } }, data: { redeemedCount: { increment: 1 } } });
        if (updated.count === 0) throw httpError(409, 'Coupon redemption limit reached');
      } else {
        await tx.coupon.update({ where: { id: coupon.id }, data: { redeemedCount: { increment: 1 } } });
      }

      return { booking: b, customer: cust };
    });

    const booking = result.booking;
    const customer = result.customer;
    try { const notifications = require('../notifications/notifications.service'); await notifications.notifyBookingCreated(businessId, booking); await notifications.sendCustomerBookingConfirmation(businessId, booking, customer); } catch (e) {}
    await maybeCreateRecurringSchedule(businessId, booking, customer, frequency);
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
  const REFERRAL_DISCOUNT_CENTS = 1000; // new customer gets 10.00 off
  const REFERRAL_REWARD_CENTS = 1000; // referrer gets a 10.00-off coupon for next time

  const existingCustomer = await prisma.customer.findFirst({ where: { businessId, phone } });
  let referrer = null;
  if (referralCode && !existingCustomer) {
    referrer = await prisma.customer.findFirst({ where: { businessId, referralCode: referralCode.toUpperCase() } });
    // A customer cannot refer themselves under a second phone number.
    if (referrer && referrer.phone === phone) referrer = null;
  }
  const referralDiscountCents = referrer ? Math.min(REFERRAL_DISCOUNT_CENTS, priceCents) : 0;
  const finalPriceCents = priceCents - referralDiscountCents;

  const customer = await upsertGuestCustomer(prisma, businessId, { firstName, lastName, email, phone });
  const customerReferralCode = customer.referralCode || (await require('../customers/customers.service').ensureReferralCode(customer.id));

  const booking = await prisma.booking.create({
    data: buildBookingData({
      businessId, customerId: customer.id, serviceId, payload, q, start, end,
      priceCents: finalPriceCents,
      extra: { referredByCustomerId: referrer?.id || null },
    }),
  });

  // Notify business dashboard (Socket.io) + confirmation email/SMS to customer
  try {
    const notifications = require('../notifications/notifications.service');
    await notifications.notifyBookingCreated(businessId, booking);
    await notifications.sendCustomerBookingConfirmation(businessId, booking, customer);
  } catch (e) {
    // non-fatal
  }

  await maybeCreateRecurringSchedule(businessId, booking, customer, frequency);

  // Reward the referrer with a single-use coupon, delivered only to them via
  // SMS/email — there's no per-customer scoping column on Coupon, so a
  // freshly generated, only-shared-with-them code is what keeps this
  // effectively "theirs" rather than a code anyone could guess and use.
  if (referrer) {
    try {
      const rewardCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
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
      const rewardMsg = `${business.name}: thanks for the referral! Use code ${rewardCode} for ${formatMoney(REFERRAL_REWARD_CENTS, business.currency)} off your next booking.`;
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
  upsertGuestCustomer,
};

/**
 * Return available time slots for a given date and service.
 * Query: ?serviceId=&date=YYYY-MM-DD&addOnIds=a,b&slotMinutes=&limit=
 *
 * The date and the opening hours are interpreted in the BUSINESS timezone and
 * returned as UTC instants (plus the timezone, so a client can render local
 * times). Slot length defaults to the service's duration including any
 * chosen add-ons — a 4-hour deep clean used to be offered as 1-hour slots and
 * then rejected at submit because the real window had no free cleaner.
 */
async function slots(businessId, query) {
  const { serviceId, date, slotMinutes, addOnIds } = query;
  if (!serviceId) throw httpError(422, 'serviceId is required');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(422, 'date must be YYYY-MM-DD');

  const svc = await prisma.service.findFirst({ where: { id: serviceId, businessId, isActive: true }, include: { addOns: true } });
  if (!svc) throw httpError(404, 'Service not found');

  const tz = await getBusinessTimezone(businessId);
  const nowLocal = getZonedParts(new Date(), tz);
  const [y, m, d] = date
    ? date.split('-').map(Number)
    : [nowLocal.year, nowLocal.month, nowLocal.day];
  const dateKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  const chosenIds = new Set(String(addOnIds || '').split(',').map((x) => x.trim()).filter(Boolean));
  const addOnMinutes = svc.addOns.filter((a) => chosenIds.has(a.id)).reduce((sum, a) => sum + (a.extraMinutes || 0), 0);
  const slotLen = parseInt(slotMinutes, 10) > 0
    ? parseInt(slotMinutes, 10)
    : (svc.estimatedMinutes || 60) + addOnMinutes;

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 48, 1), MAX_SLOTS);

  const cache = require('../../lib/cache');
  const redisKey = `slots:${businessId}:${serviceId}:${dateKey}:${slotLen}`;
  const cached = await cache.get(redisKey);
  const earliest = Date.now() + minNoticeMs();
  if (cached) {
    return { date: dateKey, timezone: tz, slots: cached.filter((sl) => new Date(sl.start).getTime() >= earliest) };
  }

  const businessHours = await prisma.businessHours.findMany({ where: { businessId, dayOfWeek } });
  const out = [];
  const seen = new Map();

  for (const h of businessHours) {
    const [oh, om] = h.openTime.split(':').map(Number);
    const [ch, cm] = h.closeTime.split(':').map(Number);
    const openMin = oh * 60 + (om || 0);
    let closeMin = ch * 60 + (cm || 0);
    if (closeMin <= openMin) closeMin += 24 * 60; // closes after midnight

    for (let mins = openMin; mins + slotLen <= closeMin; mins += SLOT_STEP_MINUTES) {
      // Wall-clock -> UTC per slot, so a DST change inside the day is correct.
      const slotStart = zonedWallTimeToUtc(y, m, d, Math.floor(mins / 60), mins % 60, tz);
      if (slotStart.getTime() < earliest) continue; // past, or inside the minimum notice
      const slotEnd = new Date(slotStart.getTime() + slotLen * 60000);
      const key = slotStart.toISOString();
      let spare = seen.get(key);
      if (spare === undefined) {
        ({ spare } = await spareCapacity(businessId, slotStart, slotEnd, {}));
        seen.set(key, spare);
      }
      if (spare > 0) out.push({ start: slotStart.toISOString(), end: slotEnd.toISOString(), available: spare });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }

  try { await cache.set(redisKey, out, 30); } catch (e) { /* cache is best-effort */ }
  return { date: dateKey, timezone: tz, slots: out };
}

module.exports.slots = slots;
