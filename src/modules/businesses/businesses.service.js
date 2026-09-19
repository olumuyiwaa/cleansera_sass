const prisma = require('../../config/database');
const { getPublicUrl, getPublicUploadUrl } = require('../../config/storage');
const { toPublicBranding } = require('../../lib/branding');
const crypto = require('crypto');

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
const PATCHABLE_BUSINESS_FIELDS = [
  'name',
  'timezone',
  'customDomain',
  'preferredPaymentCollection',
  'offlinePaymentInstructions',
];

const ALLOWED_PAYMENT_COLLECTION = ['ONLINE_CARD', 'MANUAL_OFFLINE', 'BOTH'];

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

  if ('preferredPaymentCollection' in data) {
    if (!ALLOWED_PAYMENT_COLLECTION.includes(data.preferredPaymentCollection)) {
      const err = new Error(
          `preferredPaymentCollection must be one of ${ALLOWED_PAYMENT_COLLECTION.join(', ')}`
      );
      err.status = 422;
      throw err;
    }
  }

  if ('offlinePaymentInstructions' in data) {
    const raw = data.offlinePaymentInstructions;
    data.offlinePaymentInstructions =
        raw == null || String(raw).trim() === ''
            ? null
            : String(raw).trim().slice(0, 4000);
  }

  // Normalize empty string → null so "" and null are the same "no domain"
  if ('customDomain' in data) {
    const normalized =
        data.customDomain && String(data.customDomain).trim()
            ? String(data.customDomain).trim().toLowerCase()
            : null;
    data.customDomain = normalized;

    const current = b.customDomain || null;
    if (normalized !== current) {
      // Only gate when *setting* a domain, not when clearing it
      if (normalized) {
        const { hasPlanFeature } = require('../../lib/planFeatures');
        const allowed = await hasPlanFeature(businessId, 'customDomain');
        if (!allowed) {
          const err = new Error(
              "Custom domains aren't included in your current plan. Upgrade to Pro to use one."
          );
          err.status = 402;
          throw err;
        }
      }
    }
  }

  return prisma.business.update({ where: { id: businessId }, data });
}

// Resolves stored S3 keys into permanent public URLs for anything the
// dashboard or public site actually renders as an <img> — see
// lib/branding.js (shared with widget.service, which needs the same
// resolution for the public storefront).

async function getBranding(businessId) {
  const branding = await prisma.businessBranding.findUnique({ where: { businessId } });
  return toPublicBranding(branding);
}

const THEME_STYLES = ['MODERN', 'CLASSIC', 'BOLD'];
const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'tiktok', 'linkedin', 'twitter'];
const SECTION_KEYS = ['about', 'testimonials', 'gallery', 'faq'];
// Presigned uploads write straight to Spaces from the browser, so nothing
// stops a client from requesting a URL for any key it likes — namespacing
// every key under businesses/<businessId>/branding/ at least keeps one
// business's uploads from being able to collide with or overwrite
// another's by guessing a key, even though the presign itself doesn't
// check who's asking for what path beyond that prefix.
function brandingAssetKey(businessId, kind, filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  return `businesses/${businessId}/branding/${kind}-${crypto.randomUUID()}.${ext}`;
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateBrandingPayload(payload) {
  if (payload.themeStyle !== undefined && !THEME_STYLES.includes(payload.themeStyle)) {
    const err = new Error(`themeStyle must be one of ${THEME_STYLES.join(', ')}`);
    err.status = 422;
    throw err;
  }
  if (payload.testimonials !== undefined && payload.testimonials !== null) {
    if (!Array.isArray(payload.testimonials) || payload.testimonials.some((t) => typeof t?.name !== 'string' || typeof t?.quote !== 'string')) {
      const err = new Error('testimonials must be an array of { name, quote }');
      err.status = 422;
      throw err;
    }
  }
  if (payload.faqItems !== undefined && payload.faqItems !== null) {
    if (!Array.isArray(payload.faqItems) || payload.faqItems.some((f) => typeof f?.question !== 'string' || typeof f?.answer !== 'string')) {
      const err = new Error('faqItems must be an array of { question, answer }');
      err.status = 422;
      throw err;
    }
  }
  if (payload.socialLinks !== undefined && payload.socialLinks !== null) {
    if (typeof payload.socialLinks !== 'object' || Array.isArray(payload.socialLinks)) {
      const err = new Error('socialLinks must be an object');
      err.status = 422;
      throw err;
    }
    for (const [key, value] of Object.entries(payload.socialLinks)) {
      if (!SOCIAL_PLATFORMS.includes(key)) {
        const err = new Error(`socialLinks.${key} is not a supported platform`);
        err.status = 422;
        throw err;
      }
      if (value && !isHttpUrl(value)) {
        const err = new Error(`socialLinks.${key} must be a valid URL`);
        err.status = 422;
        throw err;
      }
    }
  }
  if (payload.sectionsEnabled !== undefined && payload.sectionsEnabled !== null) {
    const se = payload.sectionsEnabled;
    if (typeof se !== 'object' || Array.isArray(se)) {
      const err = new Error('sectionsEnabled must be an object');
      err.status = 422;
      throw err;
    }
    for (const key of Object.keys(se)) {
      if (key !== 'order' && !SECTION_KEYS.includes(key)) {
        const err = new Error(`sectionsEnabled.${key} is not a recognized section`);
        err.status = 422;
        throw err;
      }
    }
    if (se.order !== undefined) {
      if (!Array.isArray(se.order) || se.order.some((k) => !SECTION_KEYS.includes(k))) {
        const err = new Error(`sectionsEnabled.order must only contain ${SECTION_KEYS.join(', ')}`);
        err.status = 422;
        throw err;
      }
    }
  }
  if (payload.galleryImageKeys !== undefined && payload.galleryImageKeys !== null) {
    if (!Array.isArray(payload.galleryImageKeys) || payload.galleryImageKeys.some((k) => typeof k !== 'string')) {
      const err = new Error('galleryImageKeys must be an array of strings');
      err.status = 422;
      throw err;
    }
    if (payload.galleryImageKeys.length > 24) {
      const err = new Error('galleryImageKeys cannot exceed 24 images');
      err.status = 422;
      throw err;
    }
  }
}

// A presigned upload URL for a public branding asset (logo, site hero
// image, or one gallery photo) — mirrors the shape of the private-document
// upload flow in cleanerSelf.service, but writes public-read so the
// public site can reference the result by a permanent URL forever
// instead of a signed one that expires.
async function brandingUploadUrl(businessId, { kind, filename, contentType }) {
  if (!['logo', 'hero', 'gallery'].includes(kind)) {
    const err = new Error('kind must be one of logo, hero, gallery');
    err.status = 422;
    throw err;
  }
  const key = brandingAssetKey(businessId, kind, filename);
  const uploadUrl = await getPublicUploadUrl(key, contentType || 'application/octet-stream');
  return { key, uploadUrl, publicUrl: getPublicUrl(key) };
}

async function getStripeConnectStatus(businessId) {
  const b = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      stripeConnectedAccountId: true,
      stripeConnectOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      preferredPaymentCollection: true,
      offlinePaymentInstructions: true,
    },
  });
  if (!b) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }

  const onlineCardReady =
      !!b.stripeChargesEnabled && !!b.stripeConnectedAccountId;
  const preferred = b.preferredPaymentCollection || 'BOTH';
  const prefersOnline =
      preferred === 'ONLINE_CARD' || preferred === 'BOTH';
  const prefersOffline =
      preferred === 'MANUAL_OFFLINE' || preferred === 'BOTH';

  return {
    connected: !!b.stripeConnectedAccountId,
    onboarded: b.stripeConnectOnboarded,
    chargesEnabled: b.stripeChargesEnabled,
    payoutsEnabled: b.stripePayoutsEnabled,
    // kept for existing dashboard code
    readyForPayments: onlineCardReady,

    // explicit product language — Connect is never required
    optional: true,
    onlineCardReady,
    canAcceptCardPayments: onlineCardReady && prefersOnline,
    canAcceptOfflinePayments: prefersOffline,
    preferredPaymentCollection: preferred,
    offlinePaymentInstructions: b.offlinePaymentInstructions || null,
    message: onlineCardReady
        ? 'Card payments are enabled via Stripe.'
        : 'Stripe Connect is optional. You can collect payment by cash or bank transfer and mark bookings paid in the dashboard.',
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

// Previously passed req.body straight into `data` with no field
// whitelist — a request could set `businessId` inside the payload itself
// and, since that's a distinct field from the `where: { businessId }`
// this runs against, silently relocate this branding row onto a
// different business's FK. Explicit picking closes that off and doubles
// as the only validation this endpoint ever had.
const BRANDING_FIELDS = [
  'logoKey', 'primaryColor', 'accentColor', 'tagline', 'widgetEmbedEnabled',
  'themeStyle', 'heroImageKey', 'aboutTitle', 'aboutBody',
  'testimonials', 'faqItems', 'galleryImageKeys', 'socialLinks', 'sectionsEnabled',
];

async function updateBranding(businessId, payload) {
  validateBrandingPayload(payload);
  const data = {};
  for (const field of BRANDING_FIELDS) {
    if (payload[field] !== undefined) data[field] = payload[field];
  }

  const existing = await prisma.businessBranding.findUnique({ where: { businessId } });
  const saved = existing
      ? await prisma.businessBranding.update({ where: { businessId }, data })
      : await prisma.businessBranding.create({ data: { businessId, ...data } });
  return toPublicBranding(saved);
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
  { key: 'services', label: 'Add at least one service', required: true },
  { key: 'hours', label: 'Set your business hours', required: true },
  { key: 'serviceAreas', label: 'Define at least one service area', required: true },
  {
    key: 'stripeConnect',
    label: 'Connect Stripe to accept card payments (optional)',
    required: false,
  },
];

async function getOnboardingStatus(businessId) {
  const [business, serviceCount, hoursCount, areaCount] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: {
        stripeConnectOnboarded: true,
        stripeChargesEnabled: true,
      },
    }),
    prisma.service.count({ where: { businessId, isActive: true } }),
    prisma.businessHours.count({ where: { businessId } }),
    prisma.serviceArea.count({ where: { businessId } }),
  ]);

  const completed = {
    services: serviceCount > 0,
    hours: hoursCount > 0,
    serviceAreas: areaCount > 0,
    stripeConnect: !!(business?.stripeConnectOnboarded && business?.stripeChargesEnabled),
  };

  const steps = ONBOARDING_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    required: s.required,
    complete: completed[s.key],
  }));

  // Only required steps block go-live
  const isComplete = steps.filter((s) => s.required).every((s) => s.complete);

  const nextIncompleteRequired =
      steps.find((s) => s.required && !s.complete)?.key || null;
  const nextIncompleteStep =
      nextIncompleteRequired || steps.find((s) => !s.complete)?.key || null;

  return {
    isComplete,
    steps,
    nextIncompleteStep,
    requiredComplete: isComplete,
    optionalStepsRemaining: steps
        .filter((s) => !s.required && !s.complete)
        .map((s) => s.key),
  };
}

module.exports = {
  listBusinesses,
  updateBusiness,
  getBranding,
  updateBranding,
  brandingUploadUrl,
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
