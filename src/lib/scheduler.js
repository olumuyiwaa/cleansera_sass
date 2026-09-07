const prisma = require('../config/database');
const { distanceMeters } = require('../utils/geo');

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function timeToMinutes(t) {
  // t is "HH:MM"
  const [hh, mm] = (t || '0:0').split(':').map(Number);
  return hh * 60 + mm;
}

function slotCovers(slot, startDate, endDate) {
  const day = startDate.getDay();
  if (slot.dayOfWeek !== day) return false;
  const s = timeToMinutes(slot.startTime);
  const e = timeToMinutes(slot.endTime);
  const startM = startDate.getHours() * 60 + startDate.getMinutes();
  const endM = endDate.getHours() * 60 + endDate.getMinutes();
  return startM >= s && endM <= e;
}

/**
 * Find available cleaners for a booking window.
 * - excludes cleaners with overlapping assignments within buffer minutes
 * - checks cleaner availability slots
 * - optionally filters by proximity (within maxDistanceMeters)
 */
async function findAvailableCleaners(businessId, startDate, endDate, { maxDistanceMeters = 30000, travelBufferMinutes = 30, lat, lng, includeEta = false } = {}) {
  // fetch active cleaners with availability
  const cleaners = await prisma.cleanerProfile.findMany({ where: { businessId, status: 'ACTIVE' }, include: { availability: true, user: true } });

  const candidates = [];
  for (const c of cleaners) {
    // availability: ensure at least one slot covers the booking window
    const hasSlot = c.availability && c.availability.some((s) => slotCovers(s, startDate, endDate));
    if (!hasSlot) continue;

    // fetch assignments that overlap with [start - buffer, end + buffer]
    const bufferMs = travelBufferMinutes * 60 * 1000;
    const windowStart = new Date(startDate.getTime() - bufferMs);
    const windowEnd = new Date(endDate.getTime() + bufferMs);
    const overlapping = await prisma.bookingAssignment.findFirst({ where: { cleanerId: c.id, booking: { scheduledStart: { lte: windowEnd }, scheduledEnd: { gte: windowStart } } }, include: { booking: true } });
    if (overlapping) continue;

    // distance check if lat/lng provided and cleaner has recent assignment or base location
    let distanceInfo = null;
    if (lat != null && lng != null) {
      // if cleaner has serviceAreaIds, skip distance heuristic; otherwise allow
      // For now, just compute distance from cleaner's last assignment end or business center if available
      const lastAssignment = await prisma.bookingAssignment.findFirst({ where: { cleanerId: c.id }, orderBy: { assignedAt: 'desc' }, include: { booking: true } });
      let refLat = lat;
      let refLng = lng;
      if (lastAssignment && lastAssignment.booking && lastAssignment.booking.latitude != null && lastAssignment.booking.longitude != null) {
        const d = distanceMeters(lastAssignment.booking.latitude, lastAssignment.booking.longitude, lat, lng);
        if (d > maxDistanceMeters) continue;
        distanceInfo = { distanceMeters: d };
      }
    }
    if (includeEta && distanceInfo == null && lat != null && lng != null) {
      // try to compute ETA via Google Distance Matrix if available
      try {
        const distanceClient = require('./distance');
        // assume cleaner's last known location from last assignment
        const lastAssignment = await prisma.bookingAssignment.findFirst({ where: { cleanerId: c.id }, orderBy: { assignedAt: 'desc' }, include: { booking: true } });
        if (lastAssignment && lastAssignment.booking && lastAssignment.booking.latitude != null && lastAssignment.booking.longitude != null) {
          const dd = await distanceClient.distanceAndDuration({ lat: lastAssignment.booking.latitude, lng: lastAssignment.booking.longitude }, { lat, lng });
          if (dd) distanceInfo = { distanceMeters: dd.distanceMeters, durationSeconds: dd.durationSeconds };
        }
      } catch (e) {
        // ignore
      }
    }

    if (includeEta && distanceInfo) {
      candidates.push({ cleaner: c, distanceMeters: distanceInfo.distanceMeters || 0, etaSeconds: distanceInfo.durationSeconds || null });
    } else if (includeEta) {
      candidates.push({ cleaner: c, distanceMeters: null, etaSeconds: null });
    } else {
      candidates.push(c);
    }
  }

  return candidates;
}

module.exports = { findAvailableCleaners };
