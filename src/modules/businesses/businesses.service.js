const prisma = require('../../config/database');

async function listBusinesses(businessId) {
  // For the businesses route (tenant-scoped), return the current business
  return prisma.business.findUnique({
    where: { id: businessId },
    include: { branding: true, addresses: true, hours: true },
  });
}

async function updateBusiness(businessId, patch) {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  const updated = await prisma.business.update({ where: { id: businessId }, data: patch });
  return updated;
}

async function getBranding(businessId) {
  return prisma.businessBranding.findUnique({ where: { businessId } });
}

async function updateBranding(businessId, payload) {
  const existing = await prisma.businessBranding.findUnique({ where: { businessId } });
  if (existing) {
    return prisma.businessBranding.update({ where: { businessId }, data: payload });
  }
  return prisma.businessBranding.create({ data: { businessId, ...payload } });
}

async function addAddress(businessId, payload) {
  return prisma.businessAddress.create({ data: { businessId, ...payload } });
}

async function updateAddress(businessId, id, payload) {
  const addr = await prisma.businessAddress.findFirst({ where: { id, businessId } });
  if (!addr) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  return prisma.businessAddress.update({ where: { id }, data: payload });
}

async function removeAddress(businessId, id) {
  const addr = await prisma.businessAddress.findFirst({ where: { id, businessId } });
  if (!addr) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  return prisma.businessAddress.delete({ where: { id } });
}

async function listServiceAreas(businessId) {
  return prisma.serviceArea.findMany({ where: { businessId } });
}

async function createServiceArea(businessId, payload) {
  return prisma.serviceArea.create({ data: { businessId, ...payload } });
}

async function updateServiceArea(businessId, id, payload) {
  const sa = await prisma.serviceArea.findFirst({ where: { id, businessId } });
  if (!sa) {
    const err = new Error('Service area not found');
    err.status = 404;
    throw err;
  }
  return prisma.serviceArea.update({ where: { id }, data: payload });
}

async function deleteServiceArea(businessId, id) {
  const sa = await prisma.serviceArea.findFirst({ where: { id, businessId } });
  if (!sa) {
    const err = new Error('Service area not found');
    err.status = 404;
    throw err;
  }
  return prisma.serviceArea.delete({ where: { id } });
}

async function listHours(businessId) {
  return prisma.businessHours.findMany({ where: { businessId }, orderBy: { dayOfWeek: 'asc' } });
}

async function updateHours(businessId, hours) {
  // hours is an array of { dayOfWeek, openTime, closeTime, isClosed }
  await prisma.businessHours.deleteMany({ where: { businessId } });
  await prisma.businessHours.createMany({ data: hours.map(h => ({ businessId, dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, isClosed: !!h.isClosed })) });
  return listHours(businessId);
}

module.exports = { listBusinesses, updateBusiness };
