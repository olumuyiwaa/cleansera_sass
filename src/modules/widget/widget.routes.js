const express = require('express');
const { body } = require('express-validator');
const controller = require('./widget.controller');
const { resolveBusinessFromHost } = require('../../middleware/resolveBusinessFromHost');
const { resolveBusinessFromSlug } = require('../../middleware/resolveBusinessFromSlug');
const { widgetLimiter } = require('../../middleware/rateLimiter');
const validate = require('../../middleware/validate');

const bookingValidators = [
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty(),
  body('phone').isMobilePhone('any'),
  body('email').optional().isEmail(),
  body('serviceId').notEmpty(),
  body('addressLine1').trim().notEmpty(),
  body('city').trim().notEmpty(),
  body('state').trim().notEmpty(),
  body('scheduledStart').isISO8601(),
  body('couponCode').optional().isString(),
  body('giftCardCode').optional().isString(),
  body('referralCode').optional().isString().isLength({ max: 20 }),
];

/** Mounts the storefront/quote/slots/bookings endpoints behind whichever tenant-resolution middleware is passed in. */
function widgetRoutesFor(resolveBusiness) {
  const router = express.Router({ mergeParams: true });
  router.use(widgetLimiter, resolveBusiness);

  router.get('/storefront', controller.storefront);
  router.post('/quote', [body('serviceId').notEmpty()], validate, controller.quote);
  router.get('/slots', controller.slots);
  router.get('/gift-cards/:code', controller.giftCardBalance);
  router.post(
    '/waitlist',
    [
      body('desiredStart').isISO8601(),
      body('desiredEnd').isISO8601(),
      body('serviceId').optional().isString(),
      body('contactEmail').optional().isEmail(),
      body('contactPhone').optional().isMobilePhone('any'),
    ],
    validate,
    controller.joinWaitlist
  );
  router.post('/bookings', bookingValidators, validate, controller.submitBooking);

  return router;
}

// Host-based: business's own custom domain or a *.WIDGET_BASE_DOMAIN
// subdomain, resolved via reverse proxy. Mounted at /widget in app.js.
const hostRouter = widgetRoutesFor(resolveBusinessFromHost);

// Slug-based: works immediately with zero DNS/proxy setup, served from a
// single shared widget domain (e.g. widget.cleansera.co/w/:subdomain/...).
// Mounted at /widget-embed/:subdomain in app.js.
const slugRouter = express.Router({ mergeParams: true });
slugRouter.use('/', widgetRoutesFor(resolveBusinessFromSlug));

module.exports = hostRouter;
module.exports.slugRouter = slugRouter;
