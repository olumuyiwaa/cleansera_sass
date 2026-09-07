const express = require('express');
const { body } = require('express-validator');
const controller = require('./messaging.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);
router.post('/', [body('subjectType').notEmpty(), body('subjectId').notEmpty()], validate, controller.createConversation);
router.post('/:id/messages', [body('body').notEmpty()], validate, controller.postMessage);

module.exports = router;
