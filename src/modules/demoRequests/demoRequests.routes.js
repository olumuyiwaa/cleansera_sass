const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { success } = require('../../utils/response');

const router = express.Router();

// Public — marketing site demo / contact form
router.post(
  '/',
  [
    body('name').notEmpty().withMessage('name is required'),
    body('email').isEmail().withMessage('valid email is required'),
    body('company').optional().isString(),
    body('phone').optional().isString(),
    body('message').optional().isString(),
    body('source').optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, email, company, phone, message, source } = req.body;
      // Log + optional audit without business scope
      logger.info('demo_request', { name, email, company, phone, message, source });
      // Store as platform audit log if desired
      try {
        await prisma.auditLog.create({
          data: {
            action: 'DEMO_REQUEST',
            entityType: 'Lead',
            entityId: email,
            metadata: { name, email, company, phone, message, source: source || 'website' },
          },
        });
      } catch (e) {
        /* non-fatal */
      }
      return success(res, 201, { received: true }, 'Thanks — we will be in touch shortly');
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
