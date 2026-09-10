const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { success } = require('../../utils/response');

const router = express.Router();

// Public — guest contact/support form (no business context, no auth).
// This is intentionally lighter than the authenticated /support-tickets
// module: it has no per-tenant SupportTicket row (that model requires a
// businessId), no ticket-number tracking, and no attachments. It exists so
// the public support page / marketing "contact us" form has somewhere real
// to submit to; anything requiring a reply thread should go through a real
// business's /support-tickets once the guest is identified with a business.
router.post(
  '/',
  [
    body('name').notEmpty().withMessage('name is required'),
    body('email').isEmail().withMessage('valid email is required'),
    body('subject').optional().isString(),
    body('category').optional().isString(),
    body('message').notEmpty().withMessage('message is required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, email, subject, category, message } = req.body;
      const reference = `CS-${Date.now().toString(36).toUpperCase()}`;

      logger.info('support_contact', { reference, name, email, subject, category });

      try {
        await prisma.auditLog.create({
          data: {
            action: 'SUPPORT_CONTACT_SUBMITTED',
            entityType: 'ContactMessage',
            entityId: reference,
            metadata: { reference, name, email, subject: subject || null, category: category || null, message },
          },
        });
      } catch (e) {
        // non-fatal — the message is still logged above
      }

      return success(
        res,
        201,
        { received: true, reference },
        "Thanks — we've received your message and will get back to you shortly"
      );
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
