const express = require('express');
const { body } = require('express-validator');
const controller = require('./auth.controller');
const validate = require('../../middleware/validate');
const { authLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

router.post(
  '/register',
  authLimiter,
  [
    body('businessName').trim().notEmpty(),
    body('subdomain').trim().isSlug().withMessage('Subdomain must be lowercase letters, numbers, and hyphens'),
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('phone').optional().isMobilePhone('any'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  validate,
  controller.register
);

router.post(
  '/login',
  authLimiter,
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  validate,
  controller.login
);

router.post('/refresh', [body('refreshToken').notEmpty()], validate, controller.refresh);
router.post('/logout', [body('refreshToken').notEmpty()], validate, controller.logout);

router.post('/password-reset/request', [body('email').isEmail().normalizeEmail()], validate, controller.requestPasswordReset);
router.post('/password-reset/confirm', [body('token').notEmpty(), body('password').isLength({ min: 8 })], validate, controller.confirmPasswordReset);

// Verified routes require authentication
const { authenticate } = require('../../middleware/authenticate');
router.post('/email/verify/request', authenticate, controller.requestEmailVerify);
router.post('/email/verify/confirm', authenticate, [body('code').notEmpty()], validate, controller.confirmEmailVerify);

router.post('/2fa/generate', authenticate, controller.generate2FA);
router.post('/2fa/verify-enable', authenticate, [body('token').notEmpty()], validate, controller.verifyEnable2FA);
router.post('/2fa/disable', authenticate, controller.disable2FA);

module.exports = router;
