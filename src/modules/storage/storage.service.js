const prisma = require('../../config/database');

async function listStorageItems(businessId) {
  // Return job photos for bookings belonging to this business
  return prisma.jobPhoto.findMany({ where: { booking: { businessId } }, orderBy: { uploadedAt: 'desc' }, take: 200 });
}

async function createStorageItem(businessId, payload) {
  // payload: { bookingId, stage, storageKey }
  const created = await prisma.jobPhoto.create({ data: { ...payload } });
  return created;
}

async function deleteStorageItem(businessId, id) {
  const p = await prisma.jobPhoto.findFirst({ where: { id }, include: { booking: true } });
  if (!p || p.booking.businessId !== businessId) {
    const err = new Error('Photo not found');
    err.status = 404;
    throw err;
  }
  await prisma.jobPhoto.delete({ where: { id } });
}

module.exports = { listStorageItems, createStorageItem, deleteStorageItem };

module.exports = { listStorageItems };
