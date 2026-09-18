const prisma = require('../config/database');
const { distanceMeters } = require('../utils/geo');

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function timeParts(t) {
  // t is "HH:MM"
  const [hh, mm] = (t || '0:0').split(':').map(Number);
  return [hh, mm];
}

/**
 * Builds a slot's actual [start, end) window as real Date objects, anchored
 * to the given calendar day (a Date already set to midnight on the day the
 * shift *starts*). If the shift's end time is numerically at or before its
 * start time (e.g. startTime "22:00", endTime "06:00"), the shift is
 * treated as an overnight one that ends on the following calendar day,
 * rather than as a zero/negative-length window.
 */
function buildSlotWindow(slot, anchorMidnight) {
  const [sh, sm] = timeParts(slot.startTime);
  const start = new Date(anchorMidnight);
  start.setHours(sh, sm, 0, 0);

  const [eh, em] = timeParts(slot.endTime);
  const end = new Date(anchorMidnight);
  end.setHours(eh, em, 0, 0);
  if (end <= start) {
    end.setDate(end.getDate() + 1);
  }
  return { start, end };
}

/**
 * Whether an availability slot covers a booking's [startDate, endDate).
 *
 * A slot's dayOfWeek marks the day its shift *begins*. For a night-shift
 * slot (e.g. Friday 22:00 - Saturday 06:00), a booking can fall on either
 * side of midnight relative to that: the pre-midnight portion still falls
 * on the slot's own dayOfWeek, but the post-midnight portion falls on the
 * *next* calendar day, and a plain "day + time-of-day" comparison (as this
 * used to be) can never match that half at all, since it never looks past
 * midnight. To catch both halves, this builds the slot's absolute window
 * anchored on the booking's own start day, and again anchored one day
 * earlier, and accepts either.
 */
function slotCovers(slot, startDate, endDate) {
  const dayOffsets = [0, -1];
  for (const dayOffset of dayOffsets) {
    const anchor = new Date(startDate);
    anchor.setDate(anchor.getDate() + dayOffset);
    anchor.setHours(0, 0, 0, 0);
    if (anchor.getDay() !== slot.dayOfWeek) continue;
    const { start, end } = buildSlotWindow(slot, anchor);
    if (startDate >= start && endDate <= end) return true;
  }
  return false;
}

/**
 * Find available cleaners for a booking window.
 * - excludes cleaners with overlapping assignments within buffer minutes
 * - checks cleaner availability slots
 * - optionally filters by proximity (within maxDistanceMeters)
 */
/**
 * Best-known reference point for a cleaner, in priority order:
 *   1. CleanerProfile.lastKnownLat/Lng - set on every clock-in/clock-out,
 *      so this reflects where they actually were most recently, not where
 *      a job happened to be.
 *   2. The location of their most recent assignment (any status) - a
 *      reasonable guess when they haven't clocked in yet today.
 *   3. The center of the business's first configured service area - better
 *      than nothing for a brand-new cleaner with no history at all.
 * Returns null only if none of the above exist (no service areas configured
 * either), in which case distance-based ranking is skipped for that cleaner.
 */
async function resolveCleanerLocation(cleaner, businessId) {
  if (cleaner.lastKnownLat != null && cleaner.lastKnownLng != null) {
    return { lat: cleaner.lastKnownLat, lng: cleaner.lastKnownLng, source: 'last_known' };
  }

  const lastAssignment = await prisma.bookingAssignment.findFirst({
    where: { cleanerId: cleaner.id },
    orderBy: { assignedAt: 'desc' },
    include: { booking: true },
  });
  if (lastAssignment?.booking?.latitude != null && lastAssignment?.booking?.longitude != null) {
    return { lat: lastAssignment.booking.latitude, lng: lastAssignment.booking.longitude, source: 'last_job' };
  }

  const area = await prisma.serviceArea.findFirst({ where: { businessId }, orderBy: { createdAt: 'asc' } });
  if (area) {
    return { lat: area.centerLat, lng: area.centerLng, source: 'service_area_center' };
  }

  return null;
}

/** Number of active (non-cancelled) assignments this cleaner already has in the 7 days around the target date - used to spread work across the team instead of always picking the closest cleaner. */
async function currentWorkload(cleanerId, aroundDate) {
  const windowStart = new Date(aroundDate);
  windowStart.setDate(windowStart.getDate() - 3);
  const windowEnd = new Date(aroundDate);
  windowEnd.setDate(windowEnd.getDate() + 4);

  return prisma.bookingAssignment.count({
    where: {
      cleanerId,
      booking: { status: { not: 'CANCELLED' }, scheduledStart: { gte: windowStart, lte: windowEnd } },
    },
  });
}

/**
 * Find available cleaners for a booking window, ranked best-first.
 * - excludes cleaners with overlapping assignments within buffer minutes
 * - checks cleaner availability slots
 * - ranks by a combined score of travel time/distance and current workload,
 *   so the #1 candidate is an actual recommendation, not just DB row order
 */
async function findAvailableCleaners(businessId, startDate, endDate, { maxDistanceMeters = 30000, travelBufferMinutes = 30, lat, lng, includeEta = false } = {}) {
  const cleaners = await prisma.cleanerProfile.findMany({ where: { businessId, status: 'ACTIVE' }, include: { availability: true, user: true } });

  const candidates = [];
  for (const c of cleaners) {
    const hasSlot = c.availability && c.availability.some((s) => slotCovers(s, startDate, endDate));
    if (!hasSlot) continue;

    const bufferMs = travelBufferMinutes * 60 * 1000;
    const windowStart = new Date(startDate.getTime() - bufferMs);
    const windowEnd = new Date(endDate.getTime() + bufferMs);
    const overlapping = await prisma.bookingAssignment.findFirst({
      where: { cleanerId: c.id, booking: { status: { not: 'CANCELLED' }, scheduledStart: { lte: windowEnd }, scheduledEnd: { gte: windowStart } } },
      include: { booking: true },
    });
    if (overlapping) continue;

    let distanceMetersVal = null;
    let etaSeconds = null;
    let locationSource = null;

    if (lat != null && lng != null) {
      const ref = await resolveCleanerLocation(c, businessId);
      if (ref) {
        locationSource = ref.source;
        if (includeEta) {
          try {
            const distanceClient = require('./distance');
            const dd = await distanceClient.distanceAndDuration(ref, { lat, lng });
            if (dd) {
              distanceMetersVal = dd.distanceMeters;
              etaSeconds = dd.durationSeconds;
            }
          } catch (e) {
            // fall through to the straight-line estimate below
          }
        }
        if (distanceMetersVal == null) {
          distanceMetersVal = distanceMeters(ref.lat, ref.lng, lat, lng);
        }
        if (distanceMetersVal > maxDistanceMeters) continue;
      }
    }

    const workload = await currentWorkload(c.id, startDate);

    candidates.push({
      cleaner: c,
      distanceMeters: distanceMetersVal,
      etaSeconds,
      locationSource,
      workload,
    });
  }

  // Rank: primarily by travel time/distance (closer is better), with
  // workload as a tiebreaker among cleaners who are roughly equally close
  // (within 2km) - prevents always stacking jobs on whoever happens to live
  // nearest the office while a less-loaded cleaner a bit farther out sits idle.
  candidates.sort((a, b) => {
    const aDist = a.etaSeconds ?? a.distanceMeters ?? Infinity;
    const bDist = b.etaSeconds ?? b.distanceMeters ?? Infinity;
    const closeEnough = Math.abs((a.distanceMeters ?? 0) - (b.distanceMeters ?? 0)) < 2000;
    if (closeEnough && a.workload !== b.workload) return a.workload - b.workload;
    return aDist - bDist;
  });

  if (includeEta) return candidates;
  return candidates.map((c) => c.cleaner);
}

module.exports = { findAvailableCleaners };
