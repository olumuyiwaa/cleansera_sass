const { error } = require('../utils/response');

/**
 * Guarantees the authenticated user is attached to a business before hitting
 * any business-scoped route, and exposes req.businessId as the single source
 * of truth for every downstream Prisma query in this request.
 *
 * SUPER_ADMIN may pass a businessId explicitly (query param or body) to act
 * on behalf of a business for support purposes; everyone else is locked to
 * the business resolved during authenticate().
 */
function scopeToBusiness(req, res, next) {
  if (req.user?.globalRole === 'SUPER_ADMIN') {
    const override = req.query.businessId || req.body?.businessId;
    if (override) {
      req.businessId = override;
      return next();
    }
  }

  if (!req.user?.businessId) {
    return error(res, 403, 'No active business membership for this account');
  }

  req.businessId = req.user.businessId;
  next();
}

module.exports = { scopeToBusiness };
