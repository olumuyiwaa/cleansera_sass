const express = require('express');
const { body } = require('express-validator');
const controller = require('./subscriptions.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

// Plans are readable by any authenticated business member
router.get('/plans', controller.listPlans);

router.get('/', controller.getSubscription);
// Billing is an ownership decision: managers can read the subscription but
// cannot start, change, cancel or open the billing portal for it.
router.post(
    '/',
    requireRole('BUSINESS_OWNER'),
    [body('planId').notEmpty().withMessage('planId is required')],
    validate,
    controller.createSubscription
);
router.put('/', requireRole('BUSINESS_OWNER'), [body('planId').notEmpty()], validate, controller.updateSubscription);
router.post('/cancel', requireRole('BUSINESS_OWNER'), controller.cancelSubscription);
router.post('/portal', requireRole('BUSINESS_OWNER'), controller.createPortalSession);
router.get('/invoices', controller.listInvoices);

module.exports = router;