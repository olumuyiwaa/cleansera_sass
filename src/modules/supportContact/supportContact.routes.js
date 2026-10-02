const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { publicFormLimiter } = require('../../middleware/rateLimiter');
const { requireCaptcha } = require('../../lib/captcha');
const { isPhoneText } = require('../../lib/contactMail');
const inquiries = require('../platformInquiries/platformInquiries.service');
const { success } = require('../../utils/response');

const router = express.Router();

// Public - the marketing site's support / contact form (no business, no auth).
// Messages become a PlatformInquiry: visible in the super-admin inbox, emailed to
// PLATFORM_INBOX_EMAIL, and acknowledged to the sender. Anything about one
// business's own customers belongs to that business's storefront contact form
// (POST /widget/.../contact), not here.
router.post(
  '/',
  publicFormLimiter,
  requireCaptcha(),
  [
    body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Please enter your name'),
    body('email').isString().trim().isLength({ max: 254 }).isEmail().withMessage('Please enter a valid email address'),
    body('phone').optional({ nullable: true, checkFalsy: true }).isString().custom(isPhoneText).withMessage('Please enter a valid phone number'),
    body('subject').optional({ nullable: true }).isString().isLength({ max: 150 }).withMessage('Subject must be at most 150 characters'),
    body('category').optional({ nullable: true }).isString().isLength({ max: 50 }),
    body('message').isString().trim().isLength({ min: 10, max: 5000 }).withMessage('Message must be between 10 and 5000 characters'),
    // Honeypot: real visitors never see or fill this.
    body('website').optional({ nullable: true }).isString().isLength({ max: 200 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      if (req.body.website) {
        // A bot. Answer like a success so it learns nothing; store and send nothing.
        const fake = require('crypto').randomBytes(5).toString('hex').toUpperCase();
        return success(res, 201, { received: true, reference: `S-${fake}` }, 'Thanks - we have received your message');
      }
      const { reference } = await inquiries.createInquiry({ kind: 'SUPPORT', ...req.body });
      return success(res, 201, { received: true, reference }, "Thanks - we've received your message and will reply by email");
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
