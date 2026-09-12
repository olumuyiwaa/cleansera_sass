const prisma = require('../config/database');
const { error } = require('../utils/response');

/**
 * Resolves the ACTIVE CleanerProfile for the logged-in user and attaches it
 * as req.cleaner, plus req.businessId for anything downstream that expects
 * tenant scoping. Used by cleaner self-service routes (/cleaner/*), which
 * are reached with a plain user access token — cleaners don't select a
 * business context at login the way staff do, so this looks the profile up
 * directly rather than relying on a businessId claim in the JWT.
 *
 * A user with more than one active cleaner profile (rare — freelancing
 * across two businesses on this platform) will always resolve to the first
 * one found; there's no multi-business cleaner switcher yet.
 */
async function requireActiveCleaner(req, res, next) {
  try {
    const cleaner = await prisma.cleanerProfile.findFirst({
      where: { userId: req.user.id, status: 'ACTIVE' },
      include: { business: true },
    });
    if (!cleaner) {
      return error(res, 403, 'Active cleaner profile not found');
    }
    req.cleaner = cleaner;
    req.businessId = cleaner.businessId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireActiveCleaner };
