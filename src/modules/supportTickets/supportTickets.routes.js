const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./supportTickets.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.list);
router.post(
  '/',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [
    body('subject').notEmpty().withMessage('subject is required'),
    body('description').notEmpty().withMessage('description is required'),
    body('priority').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
  ],
  validate,
  controller.create
);
router.get('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.get);
router.put(
  '/:id',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [
    param('id').notEmpty(),
    body('status').optional().isIn(['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']),
    body('priority').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
  ],
  validate,
  controller.update
);
router.post(
  '/:id/messages',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [param('id').notEmpty(), body('body').notEmpty()],
  validate,
  controller.addMessage
);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.remove);

module.exports = router;
