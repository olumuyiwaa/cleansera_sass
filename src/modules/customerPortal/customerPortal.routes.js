const express = require('express');
const { body } = require('express-validator');
const controller = require('./customerPortal.controller');
const { resolveBusinessFromHost } = require('../../middleware/resolveBusinessFromHost');
const { widgetLimiter } = require('../../middleware/rateLimiter');
const validate = require('../../middleware/validate');
const { requireCustomerPortal } = require('./customerPortal.middleware');

const router = express.Router();

router.use(widgetLimiter, resolveBusinessFromHost);

router.post(
  '/access/request',
  [body('phone').notEmpty()],
  validate,
  controller.requestAccess
);
router.post(
  '/access/verify',
  [body('phone').notEmpty(), body('code').notEmpty()],
  validate,
  controller.verifyAccess
);

router.use(requireCustomerPortal);

router.get('/bookings', controller.listBookings);
router.get('/bookings/:id', controller.getBooking);
router.post('/bookings/:id/cancel', controller.cancelBooking);
router.post(
  '/bookings/:id/reschedule',
  [body('scheduledStart').isISO8601()],
  validate,
  controller.rescheduleBooking
);
router.post(
  '/bookings/:id/review',
  [body('rating').isInt({ min: 1, max: 5 })],
  validate,
  controller.leaveReview
);

module.exports = router;
