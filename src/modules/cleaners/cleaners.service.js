const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const notifications = require('../notifications/notifications.service');

/**
 * Onboards a cleaner into a business. If no User exists for the given email,
 * one is created with a temporary password the cleaner resets on first login
 * (invite-link flow) — this repo stubs the "send invite" notification call.
 */
async function onboardCleaner(businessId, actorUserId, { firstName, lastName, email, phone, hireDate }) {
  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    const tempPassword = crypto.randomBytes(12).toString('hex');
    user = await prisma.user.create({
      data: {
        email,
        phone,
        firstName,
        lastName,
        passwordHash: await bcrypt.hash(tempPassword, 12),
      },
    });
    // dispatch invite email/SMS with a password-set link (notifications module)
    try {
      await notifications.sendInvite(businessId, user.id, { email, phone, tempPassword });
    } catch (e) {
      // non-fatal
    }
  }

  const existingProfile = await prisma.cleanerProfile.findUnique({
    where: { businessId_userId: { businessId, userId: user.id } },
  });
  if (existingProfile && existingProfile.status !== 'OFFBOARDED') {
    const err = new Error('This person already has a cleaner profile at this business');
    err.status = 409;
    throw err;
  }

  // Enforce subscription plan limits (maxCleaners) when onboarding
  const sub = await prisma.businessSubscription.findUnique({ where: { businessId } , include: { plan: true } });
  if (sub && sub.plan && typeof sub.plan.maxCleaners === 'number') {
    const activeCount = await prisma.cleanerProfile.count({ where: { businessId, status: 'ACTIVE' } });
    if (activeCount >= sub.plan.maxCleaners) {
      const err = new Error('Cleaner limit reached for current subscription plan');
      err.status = 402;
      throw err;
    }
  }

  const profile = existingProfile
      ? await prisma.cleanerProfile.update({
        where: { id: existingProfile.id },
        data: {
          status: 'ACTIVE',
          hireDate: hireDate ? new Date(hireDate) : new Date(),
          offboardedAt: null,
          offboardedReason: null,
        },
      })
      : await prisma.cleanerProfile.create({
        data: {
          businessId,
          userId: user.id,
          status: 'ACTIVE',
          hireDate: hireDate ? new Date(hireDate) : new Date(),
        },
      });

  await audit({
    businessId,
    actorUserId,
    action: existingProfile ? 'CLEANER_REONBOARDED' : 'CLEANER_ONBOARDED',
    entityType: 'CleanerProfile',
    entityId: profile.id,
  });

  return profile;
}

/**
 * Offboards a cleaner. Does not delete the profile — keeps history for past
 * bookings/reviews intact, just marks the relationship ended.
 */
async function offboardCleaner(businessId, actorUserId, cleanerId, reason) {
  const profile = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!profile) {
    const err = new Error('Cleaner not found for this business');
    err.status = 404;
    throw err;
  }

  const updated = await prisma.cleanerProfile.update({
    where: { id: cleanerId },
    data: { status: 'OFFBOARDED', offboardedAt: new Date(), offboardedReason: reason || null },
  });

  await audit({
    businessId,
    actorUserId,
    action: 'CLEANER_OFFBOARDED',
    entityType: 'CleanerProfile',
    entityId: cleanerId,
    metadata: { reason },
  });

  return updated;
}

async function listCleaners(businessId, { status } = {}) {
  return prisma.cleanerProfile.findMany({
    where: { businessId, ...(status ? { status } : {}) },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

async function setAvailability(businessId, cleanerId, slots) {
  const profile = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!profile) {
    const err = new Error('Cleaner not found for this business');
    err.status = 404;
    throw err;
  }

  await prisma.$transaction([
    prisma.cleanerAvailability.deleteMany({ where: { cleanerId } }),
    prisma.cleanerAvailability.createMany({
      data: slots.map((s) => ({ cleanerId, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime })),
    }),
  ]);

  return prisma.cleanerAvailability.findMany({ where: { cleanerId } });
}


/**
 * Quality + throughput snapshot for a single cleaner — average rating,
 * review count, low-rating count, jobs, and revenue. Delegates to the same
 * logic the business-wide cleaner-performance report uses so the numbers
 * never drift apart between the two views.
 */
async function getCleanerPerformance(businessId, cleanerId, { from, to } = {}) {
  const profile = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!profile) {
    const err = new Error('Cleaner not found for this business');
    err.status = 404;
    throw err;
  }
  const reportsService = require('../reports/reports.service');
  const all = await reportsService.cleanerPerformance(businessId, { from, to });
  return all.find((r) => r.cleanerId === cleanerId) || null;
}

async function clockIn(businessId, cleanerId, assignmentId, actorUserId, { lat, lng }) {
  const assignment = await prisma.bookingAssignment.findFirst({
    where: { id: assignmentId },
    include: { booking: true, cleaner: true },
  });
  if (!assignment || assignment.cleanerId !== cleanerId || assignment.booking.businessId !== businessId) {
    const err = new Error('Assignment not found or mismatch');
    err.status = 404;
    throw err;
  }

  // ensure actor is either the cleaner user or a business member
  const cleaner = await prisma.cleanerProfile.findUnique({
    where: { id: cleanerId },
    include: { user: true },
  });
  if (!cleaner) {
    const err = new Error('Cleaner profile not found');
    err.status = 404;
    throw err;
  }

  if (actorUserId !== cleaner.userId) {
    // allow business members with role to clock in on behalf
    const bm = await prisma.businessMember.findFirst({
      where: { businessId, userId: actorUserId, isActive: true },
    });
    if (!bm) {
      const err = new Error('Not authorized to clock in for this cleaner');
      err.status = 403;
      throw err;
    }
  }

  // Idempotent: already checked in
  if (assignment.checkedInAt) {
    return assignment;
  }

  // strict geo check: if booking has lat/lng, ensure within 500m
  if (
      assignment.booking.latitude != null &&
      assignment.booking.longitude != null &&
      lat != null &&
      lng != null
  ) {
    const { distanceMeters } = require('../../utils/geo');
    const d = distanceMeters(lat, lng, assignment.booking.latitude, assignment.booking.longitude);
    if (d > 500) {
      const err = new Error('Not within allowed check-in range of the booking');
      err.status = 422;
      throw err;
    }
  }

  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const a = await tx.bookingAssignment.update({
      where: { id: assignmentId },
      data: {
        checkedInAt: now,
        checkInLat: lat ?? null,
        checkInLng: lng ?? null,
      },
    });

    // Move booking into IN_PROGRESS when cleaner clocks in
    if (['REQUESTED', 'CONFIRMED', 'ASSIGNED'].includes(assignment.booking.status)) {
      await tx.booking.update({
        where: { id: assignment.bookingId },
        data: { status: 'IN_PROGRESS' },
      });
    }

    // Best-known live position for dispatch ranking
    if (lat != null && lng != null) {
      await tx.cleanerProfile.update({
        where: { id: cleanerId },
        data: {
          lastKnownLat: lat,
          lastKnownLng: lng,
          lastKnownAt: now,
        },
      });
    }

    return a;
  });

  await audit({
    businessId,
    actorUserId,
    action: 'CLEANER_CHECKED_IN',
    entityType: 'BookingAssignment',
    entityId: assignmentId,
    metadata: { lat, lng, bookingId: assignment.bookingId },
  });

  try {
    const notifications = require('../notifications/notifications.service');
    await notifications.notifyCleanerAssigned?.(businessId, assignment.booking, cleaner.userId);
  } catch (e) {
    /* non-fatal */
  }

  return updated;
}

async function clockOut(businessId, cleanerId, assignmentId, actorUserId, { lat, lng }) {
  const assignment = await prisma.bookingAssignment.findFirst({
    where: { id: assignmentId },
    include: { booking: true, cleaner: true },
  });
  if (!assignment || assignment.cleanerId !== cleanerId || assignment.booking.businessId !== businessId) {
    const err = new Error('Assignment not found or mismatch');
    err.status = 404;
    throw err;
  }

  const cleaner = await prisma.cleanerProfile.findUnique({
    where: { id: cleanerId },
    include: { user: true },
  });
  if (!cleaner) {
    const err = new Error('Cleaner profile not found');
    err.status = 404;
    throw err;
  }

  if (actorUserId !== cleaner.userId) {
    const bm = await prisma.businessMember.findFirst({
      where: { businessId, userId: actorUserId, isActive: true },
    });
    if (!bm) {
      const err = new Error('Not authorized to clock out for this cleaner');
      err.status = 403;
      throw err;
    }
  }

  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const a = await tx.bookingAssignment.update({
      where: { id: assignmentId },
      data: { checkedOutAt: now },
    });

    if (lat != null && lng != null) {
      await tx.cleanerProfile.update({
        where: { id: cleanerId },
        data: {
          lastKnownLat: lat,
          lastKnownLng: lng,
          lastKnownAt: now,
        },
      });
    }

    return a;
  });

  await audit({
    businessId,
    actorUserId,
    action: 'CLEANER_CHECKED_OUT',
    entityType: 'BookingAssignment',
    entityId: assignmentId,
    metadata: { lat, lng, bookingId: assignment.bookingId },
  });

  return updated;
}

module.exports = {
  onboardCleaner,
  offboardCleaner,
  listCleaners,
  setAvailability,
  getCleanerPerformance,
  clockIn,
  clockOut,
};