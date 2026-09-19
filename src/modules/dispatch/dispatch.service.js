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

async function createAssignment(businessId, bookingId, cleanerId, actorUserId, options = {}) {
  const { isTeamLead = false, earningsSplitPercent } = options;
  if (earningsSplitPercent != null && (earningsSplitPercent < 0 || earningsSplitPercent > 100)) {
    const err = new Error('earningsSplitPercent must be between 0 and 100');
    err.status = 422;
    throw err;
  }

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
    // Auto-pick is the same Growth+ "autoDispatch" feature as GET
    // /dispatch/suggest — gated here too since this is the other path to
    // the scheduler (posting an assignment with no cleanerId).
    const { hasPlanFeature } = require('../../lib/planFeatures');
    const allowed = await hasPlanFeature(businessId, 'autoDispatch');
    if (!allowed) {
      const err = new Error("Auto-suggested dispatch isn't included in your current plan. Pick a cleaner manually, or upgrade to use it.");
      err.status = 402;
      throw err;
    }

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

  const assignment = await prisma.bookingAssignment.create({
    data: { bookingId, cleanerId: chosenCleaner, isTeamLead, earningsSplitPercent },
  });
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

module.exports = { listDispatchItems, createAssignment, getAssignment, deleteAssignment, suggestCleaners, getCleanerDayRoute };

/**
 * Basic route/travel-time awareness for a cleaner's day. Deliberately does
 * NOT reorder jobs — each booking has a customer-facing scheduled time
 * that isn't the algorithm's to move — so this is not a traveling-salesman
 * route optimizer. What it does do: walk the day's jobs in their already-
 * scheduled order, estimate the drive between each consecutive pair (real
 * Distance Matrix data when GOOGLE_DISTANCE_MATRIX_API_KEY is configured,
 * the same haversine straight-line fallback used elsewhere otherwise), and
 * flag any pair where the gap between one job ending and the next starting
 * is tighter than the estimated drive — the concrete, actionable thing a
 * dispatcher can do something about (nudge a time, reassign one of the
 * two, or just know to expect a late arrival).
 */
async function getCleanerDayRoute(businessId, cleanerId, dateStr) {
  const cleaner = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!cleaner) {
    const err = new Error('Cleaner not found for this business');
    err.status = 404;
    throw err;
  }

  const dayStart = new Date(`${dateStr}T00:00:00`);
  const dayEnd = new Date(`${dateStr}T23:59:59.999`);
  if (Number.isNaN(dayStart.getTime())) {
    const err = new Error('date must be a valid YYYY-MM-DD');
    err.status = 422;
    throw err;
  }

  const assignments = await prisma.bookingAssignment.findMany({
    where: {
      cleanerId,
      booking: { businessId, status: { not: 'CANCELLED' }, scheduledStart: { gte: dayStart, lte: dayEnd } },
    },
    include: { booking: { include: { customer: true } } },
    orderBy: { booking: { scheduledStart: 'asc' } },
  });

  const stops = assignments.map((a) => ({
    bookingId: a.bookingId,
    address: `${a.booking.addressLine1}, ${a.booking.city}`,
    scheduledStart: a.booking.scheduledStart,
    scheduledEnd: a.booking.scheduledEnd,
    latitude: a.booking.latitude,
    longitude: a.booking.longitude,
  }));

  const distanceClient = require('../../lib/distance');
  const { distanceMeters } = require('../../utils/geo');

  const legs = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    let distanceMetersVal = null;
    let driveSeconds = null;

    if (from.latitude != null && from.longitude != null && to.latitude != null && to.longitude != null) {
      try {
        const dd = await distanceClient.distanceAndDuration(
            { lat: from.latitude, lng: from.longitude },
            { lat: to.latitude, lng: to.longitude }
        );
        if (dd) {
          distanceMetersVal = dd.distanceMeters;
          driveSeconds = dd.durationSeconds;
        }
      } catch (e) {
        // fall through to straight-line estimate
      }
      if (distanceMetersVal == null) {
        distanceMetersVal = distanceMeters(from.latitude, from.longitude, to.latitude, to.longitude);
        // Rough city-driving estimate (~30 km/h average) when no real
        // routing data is available — clearly an estimate, never
        // presented as a real ETA.
        driveSeconds = Math.round((distanceMetersVal / 1000 / 30) * 3600);
      }
    }

    const gapSeconds = (to.scheduledStart.getTime() - from.scheduledEnd.getTime()) / 1000;
    legs.push({
      fromBookingId: from.bookingId,
      toBookingId: to.bookingId,
      distanceMeters: distanceMetersVal,
      estimatedDriveSeconds: driveSeconds,
      gapSeconds,
      isTight: driveSeconds != null && gapSeconds < driveSeconds,
    });
  }

  return { date: dateStr, stops, legs };
}

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

