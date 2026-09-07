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

const scheduler = require('../../lib/scheduler');

async function createAssignment(businessId, bookingId, cleanerId, actorUserId) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, businessId } });
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }

  let chosenCleaner = cleanerId;
  if (!chosenCleaner) {
    // find candidates
    const candidates = await scheduler.findAvailableCleaners(businessId, booking.scheduledStart, booking.scheduledEnd, { lat: booking.latitude, lng: booking.longitude });
    if (!candidates || candidates.length === 0) {
      const err = new Error('No available cleaners found');
      err.status = 409;
      throw err;
    }
    chosenCleaner = candidates[0].id;
  }

  const assignment = await prisma.bookingAssignment.create({ data: { bookingId, cleanerId: chosenCleaner } });
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

async function suggestCleaners(businessId, bookingId, limit = 5) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, businessId } });
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }

  const scheduler = require('../../lib/scheduler');
  const { distanceMeters } = require('../../utils/geo');

  const candidates = await scheduler.findAvailableCleaners(businessId, booking.scheduledStart, booking.scheduledEnd, { lat: booking.latitude, lng: booking.longitude });

  // compute distance to booking location when available
  const enriched = await Promise.all(candidates.map(async (c) => {
    // try to get last known booking location
    const lastAssignment = await prisma.bookingAssignment.findFirst({ where: { cleanerId: c.id }, orderBy: { assignedAt: 'desc' }, include: { booking: true } });
    let dist = null;
    if (booking.latitude != null && booking.longitude != null) {
      if (lastAssignment && lastAssignment.booking && lastAssignment.booking.latitude != null && lastAssignment.booking.longitude != null) {
        dist = distanceMeters(lastAssignment.booking.latitude, lastAssignment.booking.longitude, booking.latitude, booking.longitude);
      } else if (c.user && c.user.latitude && c.user.longitude) {
        dist = distanceMeters(c.user.latitude, c.user.longitude, booking.latitude, booking.longitude);
      } else {
        dist = 0; // unknown, treat as zero to include
      }
    }
    return { id: c.id, user: c.user, availability: c.availability, distanceMeters: dist };
  }));

  enriched.sort((a, b) => (a.distanceMeters || 0) - (b.distanceMeters || 0));
  return enriched.slice(0, limit);
}

module.exports.suggestCleaners = suggestCleaners;
