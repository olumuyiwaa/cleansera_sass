const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./superAdmin.controller');
const { authenticate } = require('../../middleware/authenticate');
const { requireSuperAdmin } = require('../../middleware/requireSuperAdmin');
const validate = require('../../middleware/validate');

const router = express.Router();

// All super-admin routes require auth + SUPER_ADMIN global role
router.use(authenticate, requireSuperAdmin);

// Platform overview
router.get('/overview', controller.overview);

// Businesses
router.get('/businesses', controller.listBusinesses);
router.get('/businesses/:id', controller.getBusiness);
router.patch(
  '/businesses/:id/active',
  [param('id').notEmpty(), body('isActive').isBoolean()],
  validate,
  controller.setBusinessActive
);

// Subscriptions & plans
router.get('/subscriptions', controller.listSubscriptions);
router.get('/plans', controller.listPlans);

// Users
router.get('/users', controller.listUsers);
router.patch(
  '/users/:id/active',
  [param('id').notEmpty(), body('isActive').isBoolean()],
  validate,
  controller.setUserActive
);

// Support tickets (platform-wide)
router.get('/tickets', controller.listTickets);
router.patch(
  '/tickets/:id/status',
  [
    param('id').notEmpty(),
    body('status').isIn([
      'OPEN',
      'IN_PROGRESS',
      'WAITING_ON_CUSTOMER',
      'RESOLVED',
      'CLOSED',
    ]),
  ],
  validate,
  controller.updateTicketStatus
);

// Audit logs
router.get('/audit-logs', controller.listAuditLogs);

module.exports = router;
