const prisma = require('../../config/database');

async function listDispatchItems(businessId) {
  // Return recent booking assignments for dispatch dashboard
  return prisma.bookingAssignment.findMany({
    where: { booking: { businessId } },
    include: { booking: { include: { customer: true, service: true } }, cleaner: { include: { user: true } } },
    orderBy: { assignedAt: 'desc' },
    take: 200,
  });
}

async function createAssignment(businessId, bookingId, cleanerId, actorUserId) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, businessId } });
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  const assignment = await prisma.bookingAssignment.create({ data: { bookingId, cleanerId } });
  await prisma.booking.update({ where: { id: bookingId }, data: { status: 'ASSIGNED' } });
  return assignment;
}

async function getAssignment(businessId, id) {
  const a = await prisma.bookingAssignment.findFirst({ where: { id, booking: { businessId } }, include: { booking: true, cleaner: { include: { user: true } } } });
  if (!a) {
    const err = new Error('Assignment not found');
    err.status = 404;
    throw err;
  }
  return a;
}

async function deleteAssignment(businessId, id) {
  const a = await getAssignment(businessId, id);
  await prisma.bookingAssignment.delete({ where: { id } });
  await prisma.booking.update({ where: { id: a.bookingId }, data: { status: 'CONFIRMED' } });
}

module.exports = { listDispatchItems, createAssignment, getAssignment, deleteAssignment };
