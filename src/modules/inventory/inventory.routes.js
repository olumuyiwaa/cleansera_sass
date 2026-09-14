'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('./inventory.controller');

// ─── Items ────────────────────────────────────────────────
router.get('/items', ctrl.listItems);
router.get('/items/:id', ctrl.getItem);
router.post('/items', ctrl.createItem);
router.patch('/items/:id', ctrl.updateItem);

// ─── Locations ────────────────────────────────────────────
router.get('/locations', ctrl.listLocations);
router.post('/locations', ctrl.createLocation);
router.patch('/locations/:id', ctrl.updateLocation);

// ─── Stock ────────────────────────────────────────────────
router.get('/stock', ctrl.getStock);

// ─── Movements ────────────────────────────────────────────
router.post('/movements', ctrl.createMovement);

// ─── Job usage (also mount under bookings if preferred) ───
router.post('/bookings/:bookingId/usage', ctrl.recordJobUsage);

module.exports = router;
