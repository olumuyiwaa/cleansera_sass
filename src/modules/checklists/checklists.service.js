const prisma = require('../../config/database');

async function listChecklists(businessId) {
  return prisma.jobChecklist.findMany({ where: { booking: { businessId } }, include: { booking: true } });
}

module.exports = { listChecklists };

async function getChecklist(businessId, bookingId) {
  const c = await prisma.jobChecklist.findFirst({ where: { bookingId }, include: { booking: true } });
  if (!c || c.booking.businessId !== businessId) {
    const err = new Error('Checklist not found');
    err.status = 404;
    throw err;
  }
  return c;
}

async function createChecklist(businessId, bookingId, items) {
  // items is an array
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, businessId } });
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  const created = await prisma.jobChecklist.create({ data: { bookingId, items } });
  return created;
}

async function updateChecklist(businessId, bookingId, items) {
  const c = await getChecklist(businessId, bookingId);
  const updated = await prisma.jobChecklist.update({ where: { id: c.id }, data: { items } });
  return updated;
}

async function deleteChecklist(businessId, bookingId) {
  const c = await getChecklist(businessId, bookingId);
  await prisma.jobChecklist.delete({ where: { id: c.id } });
}

module.exports.getChecklist = getChecklist;
module.exports.createChecklist = createChecklist;
module.exports.updateChecklist = updateChecklist;
module.exports.deleteChecklist = deleteChecklist;
