const express = require('express');
const controller = require('./dispatch.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);
router.get('/suggest', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.suggestCleaners);
router.post('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.createAssignment);
router.get('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.getAssignment);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.removeAssignment);

module.exports = router;
