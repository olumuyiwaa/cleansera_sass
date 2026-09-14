const prisma = require('../../config/database');

// ============================================================
// FRANCHISE / MULTI-LOCATION
// ============================================================
const { audit } = require('../../utils/audit');

async function listLocations(parentBusinessId) {
  return prisma.business.findMany({
    where: { parentBusinessId },
    select: { id: true, name: true, subdomain: true, timezone: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function createLocation(parentBusinessId, actorUserId, { name, subdomain, timezone }) {
  const parent = await prisma.business.findUnique({ where: { id: parentBusinessId } });
  if (!parent) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  if (parent.parentBusinessId) {
    const err = new Error('A location cannot itself have sub-locations');
    err.status = 422;
    throw err;
  }

  const subdomainTaken = await prisma.business.findUnique({ where: { subdomain } });
  if (subdomainTaken) {
    const err = new Error('That subdomain is already taken');
    err.status = 409;
    throw err;
  }

  const location = await prisma.business.create({
    data: {
      name,
      subdomain,
      timezone: timezone || parent.timezone,
      parentBusinessId,
      branding: { create: {} },
      hours: {
        create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          openTime: '08:00',
          closeTime: '18:00',
          isClosed: dayOfWeek === 0,
        })),
      },
    },
  });

  await audit({
    businessId: parentBusinessId,
    actorUserId,
    action: 'LOCATION_CREATED',
    entityType: 'Business',
    entityId: location.id,
    metadata: { name, subdomain },
  });

  return location;
}



async function listBusinesses(businessId) {
  // For the businesses route (tenant-scoped), return the current business
  return prisma.business.findUnique({
    where: { id: businessId },
    include: { branding: true, addresses: true, hours: true },
  });
}

// Fields a BUSINESS_OWNER/BUSINESS_MANAGER can actually change through this
// endpoint. Previously this spread req.body straight into prisma's update,
// which meant a business-settings request could also silently rewrite
// stripeConnectedAccountId, isActive, parentBusinessId, or anything else on
// the model. The dashboard's own updateBusiness() type already only ever
// sends these three fields — this just makes the backend enforce it too.
const PATCHABLE_BUSINESS_FIELDS = ['name', 'timezone', 'customDomain'];

async function updateBusiness(businessId, patch) {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }

  const data = {};
  for (const key of PATCHABLE_BUSINESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) data[key] = patch[key];
  }

  // Custom domain is a Pro-tier feature per the pricing page. Only check it
  // when the value is actually changing, so a business that already has one
  // set (e.g. downgraded plans later) isn't broken by re-saving other
  // unrelated settings on this same form.
  if ('customDomain' in data && data.customDomain !== b.customDomain) {
    const { hasPlanFeature } = require('../../lib/planFeatures');
    const allowed = await hasPlanFeature(businessId, 'customDomain');
    if (!allowed) {
      const err = new Error("Custom domains aren't included in your current plan. Upgrade to Pro to use one.");
      err.status = 402;
      throw err;
    }
  }

  const updated = await prisma.business.update({ where: { id: businessId }, data });
  return updated;
}

async function getBranding(businessId) {
  return prisma.businessBranding.findUnique({ where: { businessId } });
}

async function getStripeConnectStatus(businessId) {
  const b = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      stripeConnectedAccountId: true,
      stripeConnectOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });
  if (!b) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  return {
    connected: !!b.stripeConnectedAccountId,
    onboarded: b.stripeConnectOnboarded,
    chargesEnabled: b.stripeChargesEnabled,
    payoutsEnabled: b.stripePayoutsEnabled,
    // true only once Stripe has actually confirmed the account can take
    // charges — this, not `connected`, is what should gate the "share your
    // booking link" call to action in the dashboard.
    readyForPayments: b.stripeChargesEnabled,
  };
}

async function startStripeConnectOnboarding(businessId, { refreshUrl, returnUrl } = {}) {
  const { createConnectAccountAndLink } = require('../../lib/stripeClient');
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  return createConnectAccountAndLink(business, { refreshUrl, returnUrl });
}

async function refreshStripeConnectStatus(businessId) {
  const { getConnectAccountStatus } = require('../../lib/stripeClient');
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business || !business.stripeConnectedAccountId) {
    const err = new Error('Business has not started Stripe Connect onboarding');
    err.status = 409;
    throw err;
  }
  const status = await getConnectAccountStatus(business.stripeConnectedAccountId);
  return prisma.business.update({
    where: { id: businessId },
    data: {
      stripeChargesEnabled: status.chargesEnabled,
      stripePayoutsEnabled: status.payoutsEnabled,
      stripeConnectOnboarded: status.detailsSubmitted,
    },
  });
}

async function updateBranding(businessId, payload) {
  const existing = await prisma.businessBranding.findUnique({ where: { businessId } });
  if (existing) {
    return prisma.businessBranding.update({ where: { businessId }, data: payload });
  }
  return prisma.businessBranding.create({ data: { businessId, ...payload } });
}

async function addAddress(businessId, payload) {
  return prisma.businessAddress.create({ data: { businessId, ...payload } });
}

async function updateAddress(businessId, id, payload) {
  const addr = await prisma.businessAddress.findFirst({ where: { id, businessId } });
  if (!addr) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  return prisma.businessAddress.update({ where: { id }, data: payload });
}

async function removeAddress(businessId, id) {
  const addr = await prisma.businessAddress.findFirst({ where: { id, businessId } });
  if (!addr) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  return prisma.businessAddress.delete({ where: { id } });
}

async function listServiceAreas(businessId) {
  return prisma.serviceArea.findMany({ where: { businessId } });
}

async function createServiceArea(businessId, payload) {
  return prisma.serviceArea.create({ data: { businessId, ...payload } });
}

async function updateServiceArea(businessId, id, payload) {
  const sa = await prisma.serviceArea.findFirst({ where: { id, businessId } });
  if (!sa) {
    const err = new Error('Service area not found');
    err.status = 404;
    throw err;
  }
  return prisma.serviceArea.update({ where: { id }, data: payload });
}

async function deleteServiceArea(businessId, id) {
  const sa = await prisma.serviceArea.findFirst({ where: { id, businessId } });
  if (!sa) {
    const err = new Error('Service area not found');
    err.status = 404;
    throw err;
  }
  return prisma.serviceArea.delete({ where: { id } });
}

async function listHours(businessId) {
  return prisma.businessHours.findMany({ where: { businessId }, orderBy: { dayOfWeek: 'asc' } });
}

async function updateHours(businessId, hours) {
  // hours is an array of { dayOfWeek, openTime, closeTime, isClosed }
  await prisma.businessHours.deleteMany({ where: { businessId } });
  await prisma.businessHours.createMany({ data: hours.map(h => ({ businessId, dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, isClosed: !!h.isClosed })) });
  return listHours(businessId);
}

// ============================================================
// ONBOARDING STATUS
// ============================================================
// A business shouldn't go live on the public booking widget (or start
// dispatching cleaners) until the minimum setup is done. Rather than a hard
// server-side block — which would be confusing if it silently 500'd on a
// half-configured business — this exposes a checklist the dashboard uses to
// force new owners through setup before they can use the rest of the app.
const ONBOARDING_STEPS = [
  { key: 'stripeConnect', label: 'Connect Stripe to accept customer payments' },
  { key: 'services', label: 'Add at least one service' },
  { key: 'hours', label: 'Set your business hours' },
  { key: 'serviceAreas', label: 'Define at least one service area' },
];

async function getOnboardingStatus(businessId) {
  const [business, serviceCount, hoursCount, areaCount] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { stripeConnectOnboarded: true, stripeChargesEnabled: true },
    }),
    prisma.service.count({ where: { businessId, isActive: true } }),
    prisma.businessHours.count({ where: { businessId } }),
    prisma.serviceArea.count({ where: { businessId } }),
  ]);

  const completed = {
    stripeConnect: !!(business?.stripeConnectOnboarded && business?.stripeChargesEnabled),
    services: serviceCount > 0,
    hours: hoursCount > 0,
    serviceAreas: areaCount > 0,
  };

  const steps = ONBOARDING_STEPS.map((s) => ({ ...s, complete: completed[s.key] }));
  const isComplete = steps.every((s) => s.complete);

  return {
    isComplete,
    steps,
    nextIncompleteStep: steps.find((s) => !s.complete)?.key || null,
  };
}

module.exports = {
  listBusinesses,
  updateBusiness,
  getBranding,
  updateBranding,
  addAddress,
  updateAddress,
  removeAddress,
  listServiceAreas,
  createServiceArea,
  updateServiceArea,
  deleteServiceArea,
  listHours,
  updateHours,
  // Stripe Connect
  getStripeConnectStatus,
  startStripeConnectOnboarding,
  refreshStripeConnectStatus,
  // Franchise / multi-location
  listLocations,
  createLocation,
  // Onboarding
  getOnboardingStatus,
};
