const express = require('express');
const { body } = require('express-validator');
const controller = require('./cleaners.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);

router.post(
  '/',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('phone').optional().isMobilePhone('any'),
  ],
  validate,
  controller.onboard
);

router.post('/:id/offboard', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.offboard);

router.put(
  '/:id/availability',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [body('slots').isArray()],
  validate,
  controller.updateAvailability
);

module.exports = router;
