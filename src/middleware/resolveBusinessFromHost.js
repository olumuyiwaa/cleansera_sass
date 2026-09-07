const prisma = require('../config/database');
const { error } = require('../utils/response');

/**
 * Resolves req.businessId for unauthenticated public widget routes, from the
 * Host header — a subdomain of WIDGET_BASE_DOMAIN or a registered custom
 * domain. Never accept a client-supplied businessId here: the whole point of
 * the widget surface is that a business's data is only reachable through
 * their own domain.
 */
async function resolveBusinessFromHost(req, res, next) {
  try {
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
    const baseDomain = process.env.WIDGET_BASE_DOMAIN;

    let business = null;

    if (host.endsWith(`.${baseDomain}`)) {
      const subdomain = host.replace(`.${baseDomain}`, '');
      business = await prisma.business.findUnique({ where: { subdomain } });
    } else {
      business = await prisma.business.findUnique({ where: { customDomain: host } });
    }

    if (!business || !business.isActive) {
      return error(res, 404, 'No business found for this domain');
    }

    req.businessId = business.id;
    req.business = business;
    next();
  } catch (err) {
    return error(res, 500, 'Failed to resolve business from host');
  }
}

module.exports = { resolveBusinessFromHost };
