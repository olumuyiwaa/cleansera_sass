const express = require('express');
const controller = require('./calendar.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/events', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.listEvents);

module.exports = router;
