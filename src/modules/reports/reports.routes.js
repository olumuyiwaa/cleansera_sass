const express = require('express');
const controller = require('./reports.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);
router.get('/kpis', controller.kpis);
router.get('/revenue', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.revenue);
router.get('/cleaner-performance', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.cleanerPerf);
router.get('/audit-trail', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.auditTrail);

module.exports = router;
