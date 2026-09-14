'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('./compliance.controller');

// ─── Documents (SDS, risk assessments, etc.) ──────────────
router.get('/documents', ctrl.listDocuments);
router.get('/documents/:id', ctrl.getDocument);
router.post('/documents', ctrl.createDocument);
router.patch('/documents/:id', ctrl.updateDocument);
router.delete('/documents/:id', ctrl.deleteDocument);

// ─── Training acknowledgements ────────────────────────────
router.get('/training-acks', ctrl.listTrainingAcks);
router.post('/training-acks', ctrl.recordTrainingAck);

// ─── Audits / inspections ─────────────────────────────────
router.get('/audits', ctrl.listAudits);
router.get('/audits/:id', ctrl.getAudit);
router.post('/audits', ctrl.createAudit);
router.patch('/audits/:id', ctrl.updateAudit);

module.exports = router;
