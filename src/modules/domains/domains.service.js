const crypto = require('crypto');
const dns = require('dns').promises;
const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');

const VERIFICATION_PREFIX = 'cleansera-verify=';

function verificationHost(domain) {
  return `_cleansera-challenge.${domain}`;
}

function normalizeDomain(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

async function getStatus(businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      customDomain: true,
      customDomainStatus: true,
      customDomainVerificationToken: true,
      customDomainVerifiedAt: true,
    },
  });
  if (!business || !business.customDomain) {
    return { customDomain: null, status: null };
  }
  return {
    customDomain: business.customDomain,
    status: business.customDomainStatus,
    verifiedAt: business.customDomainVerifiedAt,
    // What the business needs to add at their DNS host. TXT ownership proof
    // first, then a CNAME so traffic actually reaches us — the CNAME target
    // is deployment-specific (Caddy box / load balancer), so keep it in env
    // rather than hardcoding here.
    dnsInstructions:
      business.customDomainStatus === 'VERIFIED'
        ? null
        : {
            txt: {
              host: verificationHost(business.customDomain),
              value: `${VERIFICATION_PREFIX}${business.customDomainVerificationToken}`,
            },
            cname: {
              host: business.customDomain,
              value: process.env.CUSTOM_DOMAIN_CNAME_TARGET || 'ingress.cleansera.nl',
            },
          },
  };
}

async function setDomain(businessId, actorUserId, rawDomain) {
  const customDomain = normalizeDomain(rawDomain);
  if (!customDomain || !customDomain.includes('.')) {
    const err = new Error('Enter a valid domain, e.g. cleaning.example.nl');
    err.status = 422;
    throw err;
  }

  const existing = await prisma.business.findUnique({ where: { customDomain } });
  if (existing && existing.id !== businessId) {
    const err = new Error('That domain is already in use by another business');
    err.status = 409;
    throw err;
  }

  const token = crypto.randomBytes(16).toString('hex');
  await prisma.business.update({
    where: { id: businessId },
    data: {
      customDomain,
      customDomainStatus: 'PENDING',
      customDomainVerificationToken: token,
      customDomainVerifiedAt: null,
    },
  });
  await audit({ businessId, actorUserId, action: 'CUSTOM_DOMAIN_SET', entityType: 'Business', entityId: businessId, metadata: { customDomain } });
  return getStatus(businessId);
}

async function removeDomain(businessId, actorUserId) {
  await prisma.business.update({
    where: { id: businessId },
    data: {
      customDomain: null,
      customDomainStatus: null,
      customDomainVerificationToken: null,
      customDomainVerifiedAt: null,
    },
  });
  await audit({ businessId, actorUserId, action: 'CUSTOM_DOMAIN_REMOVED', entityType: 'Business', entityId: businessId });
}

/**
 * Checks the TXT record at _cleansera-challenge.<domain> for our token.
 * This proves control of the domain's DNS before we ever route traffic for
 * it or ask Caddy to obtain a certificate — skipping this step is what lets
 * one tenant claim a domain they don't own, or lets an outsider point DNS
 * at us to get a free cert issued in our name.
 */
async function checkOwnership(business) {
  if (!business.customDomain || !business.customDomainVerificationToken) return false;
  try {
    const records = await dns.resolveTxt(verificationHost(business.customDomain));
    const flat = records.map((r) => r.join(''));
    return flat.includes(`${VERIFICATION_PREFIX}${business.customDomainVerificationToken}`);
  } catch {
    return false; // NXDOMAIN or no TXT yet — not verified, not an error to the caller
  }
}

async function verifyNow(businessId, actorUserId) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business || !business.customDomain) {
    const err = new Error('No custom domain is set for this business');
    err.status = 400;
    throw err;
  }

  const ok = await checkOwnership(business);
  await prisma.business.update({
    where: { id: businessId },
    data: ok
      ? { customDomainStatus: 'VERIFIED', customDomainVerifiedAt: new Date() }
      : { customDomainStatus: 'FAILED' },
  });
  await audit({
    businessId,
    actorUserId,
    action: ok ? 'CUSTOM_DOMAIN_VERIFIED' : 'CUSTOM_DOMAIN_VERIFICATION_FAILED',
    entityType: 'Business',
    entityId: businessId,
  });
  return getStatus(businessId);
}

/**
 * The only thing exposed to the public resolve-domain endpoint. Deliberately
 * minimal — a subdomain string, nothing that identifies plan, IDs, or
 * business details — and only for VERIFIED custom domains, or any active
 * subdomain of the shared root domain (those don't need ownership proof;
 * the platform issued them).
 */
async function resolvePublic(host) {
  const normalized = normalizeDomain(host);
  if (!normalized) return null;

  const business = await prisma.business.findUnique({
    where: { customDomain: normalized },
    select: { subdomain: true, isActive: true, customDomainStatus: true },
  });

  if (!business || !business.isActive || business.customDomainStatus !== 'VERIFIED') {
    return null;
  }
  return business.subdomain;
}

module.exports = { getStatus, setDomain, removeDomain, verifyNow, resolvePublic, checkOwnership };
