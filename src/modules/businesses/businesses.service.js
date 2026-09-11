const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');

// ============================================================
// FRANCHISE / MULTI-LOCATION
// ============================================================
//
// A "location" is a full Business row like any other — its own cleaners,
// customers, services, bookings, and widget subdomain — with
// parentBusinessId pointing at the HQ/franchise account. Nothing about
// tenant isolation changes for a location's day-to-day operation; the only
// new capability is that the HQ owner (or an ORG_ADMIN) can list/create
// locations and switch into one via scopeToBusiness's override path.

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
  // A location can't itself be a franchise parent — keep the hierarchy one
  // level deep, which covers the real-world "HQ + branches" shape without
  // open-ended recursive rollups.
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

async function updateBusiness(businessId, patch) {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  const updated = await prisma.business.update({ where: { id: businessId }, data: patch });
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

module.exports = {
  listLocations,
  createLocation,
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
};
