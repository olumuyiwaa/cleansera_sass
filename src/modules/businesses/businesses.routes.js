const express = require('express');
const controller = require('./businesses.controller');
const { authenticate } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();
const { requireRole } = require('../../middleware/authenticate');

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);
router.put('/', controller.update);

router.get('/branding', controller.getBranding);
router.put('/branding', controller.updateBranding);

// Stripe Connect — onboarding a business to receive job-level customer
// payments directly. Distinct from the platform's own subscription billing.
router.get('/stripe-connect/status', controller.getStripeConnectStatus);
router.post('/stripe-connect/onboard', controller.startStripeConnectOnboarding);
router.post('/stripe-connect/refresh', controller.refreshStripeConnectStatus);

router.post('/addresses', controller.addAddress);
router.put('/addresses/:id', controller.updateAddress);
router.delete('/addresses/:id', controller.removeAddress);

router.get('/service-areas', controller.listServiceAreas);
router.post('/service-areas', controller.createServiceArea);
router.put('/service-areas/:id', controller.updateServiceArea);
router.delete('/service-areas/:id', controller.deleteServiceArea);

router.get('/hours', controller.listHours);
router.put('/hours', controller.updateHours);

// Franchise / multi-location. requireRole allows SUPER_ADMIN through
// automatically; any BUSINESS_MANAGER attempt is rejected since adding or
// listing locations is an ownership-level decision, not day-to-day ops.
router.get('/locations', requireRole('BUSINESS_OWNER', 'ORG_ADMIN'), controller.listLocations);
router.post('/locations', requireRole('BUSINESS_OWNER', 'ORG_ADMIN'), controller.createLocation);

module.exports = router;

