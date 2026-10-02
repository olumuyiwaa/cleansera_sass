const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { publicFormLimiter } = require('../../middleware/rateLimiter');
const { requireCaptcha } = require('../../lib/captcha');
const { isPhoneText } = require('../../lib/contactMail');
const inquiries = require('../platformInquiries/platformInquiries.service');
const { success } = require('../../utils/response');

const router = express.Router();

// Public - marketing site demo / contact request. These are sales leads: stored
// as a PlatformInquiry (kind DEMO) so they show in the admin inbox and are
// emailed to the team, rather than living only in an audit log.
router.post(
  '/',
  publicFormLimiter,
  requireCaptcha(),
  [
    body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Please enter your name'),
    body('email').isString().trim().isLength({ max: 254 }).isEmail().withMessage('Please enter a valid email address'),
    body('company').optional({ nullable: true }).isString().isLength({ max: 150 }),
    body('phone').optional({ nullable: true, checkFalsy: true }).isString().custom(isPhoneText).withMessage('Please enter a valid phone number'),
    body('message').optional({ nullable: true }).isString().isLength({ max: 3000 }),
    body('source').optional({ nullable: true }).isString().isLength({ max: 60 }),
    body('website').optional({ nullable: true }).isString().isLength({ max: 200 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      if (req.body.website) {
        const fake = require('crypto').randomBytes(5).toString('hex').toUpperCase();
        return success(res, 201, { received: true, reference: `D-${fake}` }, 'Thanks - we will be in touch shortly');
      }
      const { reference } = await inquiries.createInquiry({ kind: 'DEMO', ...req.body });
      return success(res, 201, { received: true, reference }, 'Thanks - we will be in touch shortly');
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
