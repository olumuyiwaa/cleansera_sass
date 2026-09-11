const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');

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
  if (chosenCleaner) {
    const cleaner = await prisma.cleanerProfile.findFirst({ where: { id: chosenCleaner, businessId, status: 'ACTIVE' } });
    if (!cleaner) {
      const err = new Error('Cleaner not found for this business');
      err.status = 404;
      throw err;
    }
  }
  let pickReason = 'manual';
  if (!chosenCleaner) {
    // Ranked by travel distance/ETA with workload as a tiebreaker — see
    // lib/scheduler.js. The top candidate is an actual recommendation now,
    // not just whichever row Postgres happened to return first.
    const candidates = await scheduler.findAvailableCleaners(businessId, booking.scheduledStart, booking.scheduledEnd, {
      lat: booking.latitude,
      lng: booking.longitude,
      includeEta: true,
    });
    if (!candidates || candidates.length === 0) {
      const err = new Error('No available cleaners found');
      err.status = 409;
      throw err;
    }
    const top = candidates[0];
    chosenCleaner = top.cleaner.id;
    pickReason = JSON.stringify({
      distanceMeters: top.distanceMeters,
      etaSeconds: top.etaSeconds,
      locationSource: top.locationSource,
      workload: top.workload,
    });
  }

  const assignment = await prisma.bookingAssignment.create({ data: { bookingId, cleanerId: chosenCleaner } });
  await prisma.booking.update({ where: { id: bookingId }, data: { status: 'ASSIGNED' } });
  await audit({
    businessId,
    actorUserId,
    action: 'DISPATCH_AUTO_ASSIGNED',
    entityType: 'BookingAssignment',
    entityId: assignment.id,
    metadata: { cleanerId: chosenCleaner, reason: pickReason },
  });
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

  // request ETA enrichment from scheduler when possible
  const candidates = await scheduler.findAvailableCleaners(businessId, booking.scheduledStart, booking.scheduledEnd, { lat: booking.latitude, lng: booking.longitude, includeEta: true });

  const enriched = await Promise.all(candidates.map(async (c) => {
    // c may be either a cleaner object or enriched { cleaner, distanceMeters, etaSeconds }
    let cleaner = c.cleaner || c;
    let distanceMetersVal = c.distanceMeters || null;
    let etaMinutes = c.etaSeconds ? Math.round(c.etaSeconds / 60) : null;

    // fallback: if scheduler didn't compute distance, compute lightweight heuristic
    if (distanceMetersVal == null && booking.latitude != null && booking.longitude != null) {
      const lastAssignment = await prisma.bookingAssignment.findFirst({ where: { cleanerId: cleaner.id }, orderBy: { assignedAt: 'desc' }, include: { booking: true } });
      if (lastAssignment && lastAssignment.booking && lastAssignment.booking.latitude != null && lastAssignment.booking.longitude != null) {
        distanceMetersVal = distanceMeters(lastAssignment.booking.latitude, lastAssignment.booking.longitude, booking.latitude, booking.longitude);
      } else if (cleaner.user && cleaner.user.latitude && cleaner.user.longitude) {
        distanceMetersVal = distanceMeters(cleaner.user.latitude, cleaner.user.longitude, booking.latitude, booking.longitude);
      }
    }

    return { id: cleaner.id, user: cleaner.user, availability: cleaner.availability, distanceMeters: distanceMetersVal, etaMinutes };
  }));

  enriched.sort((a, b) => (a.etaMinutes != null && b.etaMinutes != null) ? a.etaMinutes - b.etaMinutes : (a.distanceMeters || 0) - (b.distanceMeters || 0));
  return enriched.slice(0, limit);
}

module.exports.suggestCleaners = suggestCleaners;
