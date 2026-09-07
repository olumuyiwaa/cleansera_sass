const prisma = require('../../config/database');

async function generateSummary(businessId) {
  const totalBookings = await prisma.booking.count({ where: { businessId } });
  const byStatus = await prisma.booking.groupBy({ by: ['status'], where: { businessId }, _count: { _all: true } });
  const recent = await prisma.booking.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 10 });

  return { totalBookings, byStatus, recent };
}

module.exports = { generateSummary };

async function generateKPIs(businessId, { from, to } = {}) {
  const where = { businessId };
  if (from) where.scheduledStart = { gte: new Date(from) };
  if (to) where.scheduledStart = { ...(where.scheduledStart || {}), lte: new Date(to) };

  const total = await prisma.booking.count({ where });
  const completed = await prisma.booking.count({ where: { ...where, status: 'COMPLETED' } });
  const completionRate = total === 0 ? 0 : Math.round((completed / total) * 10000) / 100;

  const bookingsPerCleaner = await prisma.bookingAssignment.groupBy({ by: ['cleanerId'], where: { booking: { businessId } }, _count: { bookingId: true }, take: 20 });

  const repeatCustomers = await prisma.customer.count({ where: { businessId, bookings: { some: {} } } });

  return { total, completed, completionRate, bookingsPerCleaner, repeatCustomers };
}

module.exports.generateKPIs = generateKPIs;
