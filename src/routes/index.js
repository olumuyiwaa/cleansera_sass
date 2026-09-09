const express = require('express');

const router = express.Router();

// Auth + tenant onboarding
router.use('/auth', require('../modules/auth/auth.routes'));

// Business dashboard (authenticated, tenant-scoped)
router.use('/businesses', require('../modules/businesses/businesses.routes'));
router.use('/businesses/pricing', require('../modules/pricing/pricing.routes'));
router.use('/subscriptions', require('../modules/subscriptions/subscriptions.routes'));
router.use('/cleaners', require('../modules/cleaners/cleaners.routes'));
router.use('/customers', require('../modules/customers/customers.routes'));
router.use('/services', require('../modules/services/services.routes'));
router.use('/bookings', require('../modules/bookings/bookings.routes'));
router.use('/dispatch', require('../modules/dispatch/dispatch.routes'));
router.use('/checklists', require('../modules/checklists/checklists.routes'));
router.use('/checklist-templates', require('../modules/checklistTemplates/checklistTemplates.routes'));
router.use('/messaging', require('../modules/messaging/messaging.routes'));
router.use('/notifications', require('../modules/notifications/notifications.routes'));
router.use('/reviews', require('../modules/reviews/reviews.routes'));
router.use('/reports', require('../modules/reports/reports.routes'));
router.use('/storage', require('../modules/storage/storage.routes'));

// Public booking widget (unauthenticated, resolved from Host header)
router.use('/widget', require('../modules/widget/widget.routes'));
router.use('/portal', require('../modules/customerPortal/customerPortal.routes'));

module.exports = router;
