const prisma = require('../config/database');
const { error } = require('../utils/response');

/**
 * Resolves req.businessId for public widget routes from a `:subdomain`
 * route param instead of the Host header. This exists alongside
 * resolveBusinessFromHost (not a replacement) for deployments where custom
 * per-business domains/subdomains aren't wired up at the reverse-proxy
 * level yet — the same widget frontend can be served from one shared
 * domain (e.g. widget.cleansera.co/w/:subdomain) and still resolve the
 * correct tenant.
 *
 * Safe to accept from the client: a business's subdomain is not a secret —
 * it's public routing information, the same as it would be in a DNS label.
 * It is NOT the internal cuid `businessId`, which we never accept from the
 * client on public routes.
 */
async function resolveBusinessFromSlug(req, res, next) {
  try {
    const subdomain = (req.params.subdomain || '').toLowerCase().trim();
    if (!subdomain) {
      return error(res, 400, 'Missing business subdomain');
    }

    const business = await prisma.business.findUnique({ where: { subdomain } });

    if (!business || !business.isActive) {
      return error(res, 404, 'No business found for this link');
    }

    req.businessId = business.id;
    req.business = business;
    next();
  } catch (err) {
    return error(res, 500, 'Failed to resolve business');
  }
}

module.exports = { resolveBusinessFromSlug };
