const express = require('express');
const { body } = require('express-validator');
const controller = require('./widget.controller');
const { resolveBusinessFromHost } = require('../../middleware/resolveBusinessFromHost');
const { widgetLimiter } = require('../../middleware/rateLimiter');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(widgetLimiter, resolveBusinessFromHost);

router.get('/storefront', controller.storefront);

router.post('/quote', [body('serviceId').notEmpty()], validate, controller.quote);
router.get('/slots', controller.slots);

router.post(
  '/bookings',
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('phone').isMobilePhone('any'),
    body('email').optional().isEmail(),
    body('serviceId').notEmpty(),
    body('addressLine1').trim().notEmpty(),
    body('city').trim().notEmpty(),
    body('state').trim().notEmpty(),
    body('scheduledStart').isISO8601(),
  ],
  validate,
  controller.submitBooking
);

module.exports = router;
