const express = require('express');
const controller = require('./reports.controller');
const { authenticate } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);

router.get('/kpis', controller.kpis);

module.exports = router;
