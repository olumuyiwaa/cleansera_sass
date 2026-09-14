const { error } = require('../utils/response');

/**
 * Restricts a route to users with globalRole === SUPER_ADMIN.
 * Must run after authenticate().
 */
function requireSuperAdmin(req, res, next) {
  if (req.user?.globalRole !== 'SUPER_ADMIN') {
    return error(res, 403, 'Super admin access required');
  }
  return next();
}

module.exports = { requireSuperAdmin };
