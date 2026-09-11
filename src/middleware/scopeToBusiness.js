const { error } = require('../utils/response');
const prisma = require('../config/database');

/**
 * Guarantees the authenticated user is attached to a business before hitting
 * a tenant-scoped route. Sets `req.businessId` as the single source
 * of truth for every downstream Prisma query in this request.
 *
 * SUPER_ADMIN may pass a businessId explicitly (query param or body) to act
 * on behalf of a business for support purposes.
 *
 * ORG_ADMIN (a membership on a *parent* franchise Business) may likewise
 * pass a businessId explicitly, but only to one of that parent's own
 * `locations` — never to an arbitrary business. This is what lets a
 * franchise owner switch between their locations from one login without
 * granting blanket cross-tenant access.
 *
 * Everyone else is locked to the business resolved during authenticate().
 */
async function scopeToBusiness(req, res, next) {
  const override = req.query.businessId || req.body?.businessId;

  if (req.user?.globalRole === 'SUPER_ADMIN' && override) {
    req.businessId = override;
    return next();
  }

  // BUSINESS_OWNER is included here too: the owner of a parent/HQ business
  // naturally has the same cross-location reach as an explicitly assigned
  // ORG_ADMIN, without a separate role grant.
  const isOrgLevelRole = req.user?.businessRole === 'ORG_ADMIN' || req.user?.businessRole === 'BUSINESS_OWNER';
  if (override && isOrgLevelRole && req.user?.businessId) {
    const location = await prisma.business.findFirst({
      where: { id: override, parentBusinessId: req.user.businessId },
      select: { id: true },
    });
    if (!location) {
      return error(res, 403, 'That business is not one of your organization\'s locations');
    }
    req.businessId = location.id;
    req.orgId = req.user.businessId;
    return next();
  }

  if (!req.user?.businessId) {
    return error(res, 403, 'No business context');
  }

  req.businessId = req.user.businessId;
  return next();
}

module.exports = { scopeToBusiness };
