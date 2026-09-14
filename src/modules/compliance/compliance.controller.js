'use strict';

const complianceService = require('./compliance.service');
const {
  createDocumentSchema,
  updateDocumentSchema,
  trainingAckSchema,
  createAuditSchema,
  updateAuditSchema,
} = require('./compliance.validation');

function getBusinessId(req) {
  return req.business?.id || req.user?.businessId;
}

// ─── Documents ────────────────────────────────────────────

async function listDocuments(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const docs = await complianceService.listDocuments(businessId, {
      type: req.query.type,
      expiringSoon: req.query.expiringSoon === 'true',
    });
    res.json(docs);
  } catch (err) {
    next(err);
  }
}

async function getDocument(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const doc = await complianceService.getDocument(businessId, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
}

async function createDocument(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createDocumentSchema.parse(req.body);
    const doc = await complianceService.createDocument(businessId, data, req.user?.id);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
}

async function updateDocument(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = updateDocumentSchema.parse(req.body);
    const doc = await complianceService.updateDocument(businessId, req.params.id, data);
    res.json(doc);
  } catch (err) {
    next(err);
  }
}

async function deleteDocument(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    await complianceService.deleteDocument(businessId, req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ─── Training ─────────────────────────────────────────────

async function recordTrainingAck(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = trainingAckSchema.parse(req.body);
    const ack = await complianceService.recordTrainingAck(businessId, data);
    res.status(201).json(ack);
  } catch (err) {
    next(err);
  }
}

async function listTrainingAcks(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const acks = await complianceService.listTrainingAcks(businessId, {
      cleanerId: req.query.cleanerId,
      documentId: req.query.documentId,
    });
    res.json(acks);
  } catch (err) {
    next(err);
  }
}

// ─── Audits ───────────────────────────────────────────────

async function listAudits(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const audits = await complianceService.listAudits(businessId, {
      status: req.query.status,
    });
    res.json(audits);
  } catch (err) {
    next(err);
  }
}

async function getAudit(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const audit = await complianceService.getAudit(businessId, req.params.id);
    if (!audit) return res.status(404).json({ error: 'Audit not found' });
    res.json(audit);
  } catch (err) {
    next(err);
  }
}

async function createAudit(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createAuditSchema.parse(req.body);
    const audit = await complianceService.createAudit(businessId, data);
    res.status(201).json(audit);
  } catch (err) {
    next(err);
  }
}

async function updateAudit(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = updateAuditSchema.parse(req.body);
    const audit = await complianceService.updateAudit(businessId, req.params.id, data);
    res.json(audit);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  deleteDocument,
  recordTrainingAck,
  listTrainingAcks,
  listAudits,
  getAudit,
  createAudit,
  updateAudit,
};
