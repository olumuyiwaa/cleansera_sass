const express = require('express');
const controller = require('./businesses.controller');
const { authenticate } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);
router.put('/', controller.update);

router.get('/branding', controller.getBranding);
router.put('/branding', controller.updateBranding);

router.post('/addresses', controller.addAddress);
router.put('/addresses/:id', controller.updateAddress);
router.delete('/addresses/:id', controller.removeAddress);

router.get('/service-areas', controller.listServiceAreas);
router.post('/service-areas', controller.createServiceArea);
router.put('/service-areas/:id', controller.updateServiceArea);
router.delete('/service-areas/:id', controller.deleteServiceArea);

router.get('/hours', controller.listHours);
router.put('/hours', controller.updateHours);

module.exports = router;
