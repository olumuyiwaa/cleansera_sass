const prisma = require('../config/database');
const { error } = require('../utils/response');

/**
 * Reads a boolean flag out of the business's active SubscriptionPlan.features
 * JSON (e.g. { autoDispatch: true, customDomain: false, reportExports: true }).
 *
 * Fails OPEN — returns true — when the business has no BusinessSubscription
 * row yet, no plan on it, or the key simply isn't present in that plan's
 * features JSON. This mirrors the existing maxCleaners check in
 * cleaners.service.js: a business mid-setup, before billing is even wired
 * up, shouldn't be blocked from using the product. The intent is to gate
 * *known* tier differences, not to lock everything down by default.
 */
async function hasPlanFeature(businessId, featureKey) {
  const sub = await prisma.businessSubscription.findUnique({
    where: { businessId },
    include: { plan: true },
  });
  if (!sub || !sub.plan) return true;

  const features = sub.plan.features || {};
  if (!(featureKey in features)) return true;
  return features[featureKey] !== false;
}

/** Express middleware form of hasPlanFeature, for gating a whole route. */
function requirePlanFeature(featureKey, label) {
  return async (req, res, next) => {
    try {
      const allowed = await hasPlanFeature(req.businessId, featureKey);
      if (!allowed) {
        return error(res, 402, `${label || featureKey} isn't included in your current plan. Upgrade to use it.`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { hasPlanFeature, requirePlanFeature };
