const express = require('express');
const controller = require('./calendar.controller');
const { authenticate } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/events', controller.listEvents);

module.exports = router;
