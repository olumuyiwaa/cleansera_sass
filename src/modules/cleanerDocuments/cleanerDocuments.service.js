const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const { getSignedUploadUrl, getSignedDownloadUrl, deleteObject } = require('../../config/storage');

async function listDocuments(businessId, { cleanerId, type } = {}) {
  const where = { businessId };
  if (cleanerId) where.cleanerId = cleanerId;
  if (type) where.type = type;

  return prisma.cleanerDocument.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      cleaner: {
        include: { user: { select: { firstName: true, lastName: true, email: true } } },
      },
    },
  });
}

async function getDocument(businessId, id) {
  const doc = await prisma.cleanerDocument.findFirst({
    where: { id, businessId },
    include: {
      cleaner: {
        include: { user: { select: { firstName: true, lastName: true, email: true } } },
      },
    },
  });
  if (!doc) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }
  return doc;
}

async function getUploadUrl(businessId, { cleanerId, contentType, filename }) {
  const cleaner = await prisma.cleanerProfile.findFirst({
    where: { id: cleanerId, businessId },
  });
  if (!cleaner) {
    const err = new Error('Cleaner not found');
    err.status = 404;
    throw err;
  }
  const safeName = (filename || 'doc').replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `businesses/${businessId}/cleaners/${cleanerId}/docs/${Date.now()}-${safeName}`;
  const uploadUrl = await getSignedUploadUrl(key, contentType || 'application/octet-stream');
  return { uploadUrl, storageKey: key };
}

async function createDocument(businessId, actorUserId, body) {
  const cleaner = await prisma.cleanerProfile.findFirst({
    where: { id: body.cleanerId, businessId },
  });
  if (!cleaner) {
    const err = new Error('Cleaner not found');
    err.status = 404;
    throw err;
  }

  const doc = await prisma.cleanerDocument.create({
    data: {
      businessId,
      cleanerId: body.cleanerId,
      type: body.type || 'OTHER',
      title: body.title,
      storageKey: body.storageKey,
      mimeType: body.mimeType || null,
      fileSize: body.fileSize || null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      notes: body.notes || null,
      uploadedBy: actorUserId,
    },
  });

  await audit({
    businessId,
    actorUserId,
    action: 'CLEANER_DOCUMENT_UPLOADED',
    entityType: 'CleanerDocument',
    entityId: doc.id,
    metadata: { cleanerId: body.cleanerId, type: doc.type, title: doc.title },
  });

  return doc;
}

async function getDownloadUrl(businessId, id) {
  const doc = await getDocument(businessId, id);
  const downloadUrl = await getSignedDownloadUrl(doc.storageKey);
  return { downloadUrl, document: doc };
}

async function deleteDocument(businessId, id, actorUserId) {
  const doc = await getDocument(businessId, id);
  try {
    await deleteObject(doc.storageKey);
  } catch (e) {
    // storage may be misconfigured in dev — still remove DB row
  }
  await prisma.cleanerDocument.delete({ where: { id } });
  await audit({
    businessId,
    actorUserId,
    action: 'CLEANER_DOCUMENT_DELETED',
    entityType: 'CleanerDocument',
    entityId: id,
    metadata: { cleanerId: doc.cleanerId, title: doc.title },
  });
}

module.exports = {
  listDocuments,
  getDocument,
  getUploadUrl,
  createDocument,
  getDownloadUrl,
  deleteDocument,
};
