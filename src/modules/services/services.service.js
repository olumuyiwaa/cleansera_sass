const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');

async function listServices(businessId) {
  return prisma.service.findMany({ where: { businessId, isActive: true }, include: { addOns: true }, orderBy: { createdAt: 'desc' } });
}

async function createService(businessId, payload) {
  const created = await prisma.service.create({ data: { businessId, ...payload } });
  await audit({ businessId, action: 'SERVICE_CREATED', entityType: 'Service', entityId: created.id });
  return created;
}

async function getService(businessId, id) {
  const s = await prisma.service.findFirst({ where: { id, businessId }, include: { addOns: true } });
  if (!s) {
    const err = new Error('Service not found');
    err.status = 404;
    throw err;
  }
  return s;
}

async function updateService(businessId, id, patch) {
  await getService(businessId, id);
  const updated = await prisma.service.update({ where: { id }, data: patch });
  await audit({ businessId, action: 'SERVICE_UPDATED', entityType: 'Service', entityId: id, metadata: patch });
  return updated;
}

async function deleteService(businessId, id) {
  await getService(businessId, id);
  await prisma.service.delete({ where: { id } });
  await audit({ businessId, action: 'SERVICE_DELETED', entityType: 'Service', entityId: id });
}

module.exports = { listServices, createService, getService, updateService, deleteService };
