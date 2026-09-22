const express = require('express');
const { body } = require('express-validator');
const controller = require('./domains.controller');
const validate = require('../../middleware/validate');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

// ── Authenticated: a business owner/manager setting up their own domain ──
const router = express.Router();
router.use(authenticate, scopeToBusiness);

router.get('/', controller.getStatus);

router.post(
  '/',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [body('customDomain').isString().trim().isLength({ min: 3, max: 255 })],
  validate,
  controller.setDomain,
);

router.post('/verify', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.verifyNow);

router.delete('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.removeDomain);

// ── Public, unauthenticated, cacheable ──────────────────────────────────
// GET /api/v1/public/resolve-domain?host=acme-cleaning.nl
// Consumed by: the frontend's edge middleware (to rewrite the request to
// /[subdomain]) and by Caddy's on_demand_tls "ask" hook (to decide whether
// to issue a certificate for an incoming Host at all). Only ever returns a
// business's public subdomain — never internal IDs, plan, or branding —
// and only for domains that have completed DNS ownership verification.
const publicRouter = express.Router();
publicRouter.get('/resolve-domain', controller.resolvePublic);

// Matches this codebase's existing widget.routes.js / customerPortal.routes.js
// pattern (module.exports = mainRouter; module.exports.extra = otherRouter)
// rather than a destructured export, so it mounts the same way in
// routes/index.js as every other module already does.
module.exports = router;
module.exports.publicRouter = publicRouter;
