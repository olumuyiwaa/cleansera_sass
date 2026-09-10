const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');

async function listServices(businessId) {
  // Dashboard listing intentionally includes inactive services too — a
  // business needs to see and re-enable something it turned off. The
  // public widget/storefront (widget.service.js) does its own
  // isActive-only filtering for customer-facing listings.
  return prisma.service.findMany({ where: { businessId }, include: { addOns: true }, orderBy: { createdAt: 'desc' } });
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

// ------------------------------------------------------------------
// Add-ons — there was previously no way to manage these via the API at
// all (createService/updateService only ever wrote scalar Service
// fields), even though the pricing engine and booking/widget flows both
// fully support add-ons. These close that gap.
// ------------------------------------------------------------------

async function addAddOn(businessId, serviceId, { name, priceCents, extraMinutes }) {
  await getService(businessId, serviceId); // 404s if not found / wrong business
  const addOn = await prisma.serviceAddOn.create({
    data: { serviceId, name, priceCents: priceCents || 0, extraMinutes: extraMinutes || 0 },
  });
  await audit({ businessId, action: 'SERVICE_ADDON_CREATED', entityType: 'ServiceAddOn', entityId: addOn.id, metadata: { serviceId, name } });
  return addOn;
}

async function updateAddOn(businessId, serviceId, addOnId, patch) {
  await getService(businessId, serviceId);
  const existing = await prisma.serviceAddOn.findFirst({ where: { id: addOnId, serviceId } });
  if (!existing) {
    const err = new Error('Add-on not found for this service');
    err.status = 404;
    throw err;
  }
  const updated = await prisma.serviceAddOn.update({ where: { id: addOnId }, data: patch });
  await audit({ businessId, action: 'SERVICE_ADDON_UPDATED', entityType: 'ServiceAddOn', entityId: addOnId, metadata: patch });
  return updated;
}

async function deleteAddOn(businessId, serviceId, addOnId) {
  await getService(businessId, serviceId);
  const existing = await prisma.serviceAddOn.findFirst({ where: { id: addOnId, serviceId } });
  if (!existing) {
    const err = new Error('Add-on not found for this service');
    err.status = 404;
    throw err;
  }
  await prisma.serviceAddOn.delete({ where: { id: addOnId } });
  await audit({ businessId, action: 'SERVICE_ADDON_DELETED', entityType: 'ServiceAddOn', entityId: addOnId, metadata: { serviceId } });
}

module.exports = {
  listServices,
  createService,
  getService,
  updateService,
  deleteService,
  addAddOn,
  updateAddOn,
  deleteAddOn,
};
