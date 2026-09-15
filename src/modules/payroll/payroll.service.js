const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const logger = require('../../config/logger');

async function getCleanerOrThrow(businessId, cleanerId) {
  const cleaner = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!cleaner) {
    const err = new Error('Cleaner not found for this business');
    err.status = 404;
    throw err;
  }
  return cleaner;
}

function validateCompensationInput(type, value) {
  const allowedTypes = ['PERCENT', 'FLAT_PER_JOB', 'HOURLY'];
  if (!allowedTypes.includes(type)) {
    const err = new Error(`type must be one of ${allowedTypes.join(', ')}`);
    err.status = 422;
    throw err;
  }
  if (!Number.isInteger(value) || value <= 0) {
    const err = new Error('value must be a positive integer');
    err.status = 422;
    throw err;
  }
  if (type === 'PERCENT' && value > 100) {
    const err = new Error('a PERCENT value cannot exceed 100');
    err.status = 422;
    throw err;
  }
}

/** Sets (or replaces) how a cleaner is paid. One rule per cleaner. */
async function setCompensation(businessId, actorUserId, cleanerId, { type, value }) {
  await getCleanerOrThrow(businessId, cleanerId);
  validateCompensationInput(type, value);

  const comp = await prisma.cleanerCompensation.upsert({
    where: { cleanerId },
    update: { type, value },
    create: { businessId, cleanerId, type, value },
  });

  await audit({
    businessId,
    actorUserId,
    action: 'CLEANER_COMPENSATION_SET',
    entityType: 'CleanerCompensation',
    entityId: comp.id,
    metadata: { cleanerId, type, value },
  });

  return comp;
}

async function listCompensations(businessId) {
  return prisma.cleanerCompensation.findMany({
    where: { businessId },
    include: { cleaner: { select: { id: true, userId: true, user: { select: { firstName: true, lastName: true, email: true } } } } },
  });
}

/**
 * Computes each assigned cleaner's earning for a just-completed booking and
 * records it. Idempotent — safe to call more than once for the same
 * booking (e.g. the cleaner-complete path and an admin re-complete both
 * calling it) because of the (bookingId, cleanerId) unique constraint; a
 * repeat call is a silent no-op per cleaner rather than a duplicate charge.
 *
 * A cleaner with no CleanerCompensation row configured for them simply
 * accrues nothing — this never guesses a rate nobody set.
 */
async function computeEarningsForBooking(businessId, bookingId) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    include: { assignments: true },
  });
  if (!booking || booking.assignments.length === 0) return [];

  const created = [];
  for (const assignment of booking.assignments) {
    try {
      const existing = await prisma.cleanerEarning.findUnique({
        where: { bookingId_cleanerId: { bookingId, cleanerId: assignment.cleanerId } },
      });
      if (existing) continue;

      const comp = await prisma.cleanerCompensation.findUnique({ where: { cleanerId: assignment.cleanerId } });
      if (!comp) continue;

      let amountCents = 0;
      if (comp.type === 'PERCENT') {
        amountCents = Math.round(((booking.quotedPriceCents || 0) * comp.value) / 100);
      } else if (comp.type === 'FLAT_PER_JOB') {
        amountCents = comp.value;
      } else if (comp.type === 'HOURLY') {
        if (!assignment.checkedInAt || !assignment.checkedOutAt) {
          // Can't compute a hint of a number without real clock times —
          // skip rather than fabricate a duration.
          continue;
        }
        const hours = (assignment.checkedOutAt.getTime() - assignment.checkedInAt.getTime()) / 3600000;
        amountCents = Math.round(hours * comp.value);
      }
      if (amountCents <= 0) continue;

      const earning = await prisma.cleanerEarning.create({
        data: {
          businessId,
          cleanerId: assignment.cleanerId,
          bookingId,
          amountCents,
          compensationType: comp.type,
          compensationValue: comp.value,
        },
      });
      created.push(earning);
    } catch (err) {
      // Non-fatal per cleaner — one bad row shouldn't block the booking
      // completion flow that triggered this, or the other cleaners on the
      // same job from earning correctly.
      logger.error('Failed to compute cleaner earning', { bookingId, cleanerId: assignment.cleanerId, error: err.message });
    }
  }
  return created;
}

async function listEarnings(businessId, { cleanerId, status } = {}) {
  return prisma.cleanerEarning.findMany({
    where: { businessId, ...(cleanerId ? { cleanerId } : {}), ...(status ? { status } : {}) },
    include: { booking: { select: { id: true, scheduledAt: true, quotedPriceCents: true } } },
    orderBy: { earnedAt: 'desc' },
  });
}

/**
 * A cleaner's own earnings summary — used by the cleaner app instead of the
 * old client-side estimate that never reflected a real payroll figure.
 */
async function getEarningsSummaryByCleanerId(cleanerId) {
  const [pending, paid, recent, recentPayouts] = await Promise.all([
    prisma.cleanerEarning.aggregate({ where: { cleanerId, status: { in: ['PENDING', 'IN_PAYOUT'] } }, _sum: { amountCents: true } }),
    prisma.cleanerEarning.aggregate({ where: { cleanerId, status: 'PAID' }, _sum: { amountCents: true } }),
    prisma.cleanerEarning.findMany({ where: { cleanerId }, orderBy: { earnedAt: 'desc' }, take: 20 }),
    prisma.payout.findMany({ where: { cleanerId }, orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  return {
    pendingCents: pending._sum.amountCents || 0,
    lifetimePaidCents: paid._sum.amountCents || 0,
    recentEarnings: recent,
    recentPayouts,
  };
}

/** Same as above, resolved from a userId — for callers that only have the logged-in user, not their CleanerProfile. */
async function getMyEarningsSummary(cleanerUserId) {
  const cleaner = await prisma.cleanerProfile.findFirst({ where: { userId: cleanerUserId, status: 'ACTIVE' } });
  if (!cleaner) {
    const err = new Error('Active cleaner profile not found');
    err.status = 403;
    throw err;
  }
  return getEarningsSummaryByCleanerId(cleaner.id);
}

/**
 * Batches a cleaner's currently-PENDING earnings into a Payout the business
 * marks as paid once the money has actually moved outside CleanSera (bank
 * transfer, cash, their own payroll run).
 */
async function createPayout(businessId, actorUserId, cleanerId, { method, reference } = {}) {
  await getCleanerOrThrow(businessId, cleanerId);

  const pending = await prisma.cleanerEarning.findMany({
    where: { businessId, cleanerId, status: 'PENDING' },
    orderBy: { earnedAt: 'asc' },
  });
  if (pending.length === 0) {
    const err = new Error('No pending earnings to pay out for this cleaner');
    err.status = 422;
    throw err;
  }

  const totalCents = pending.reduce((sum, e) => sum + e.amountCents, 0);
  const periodStart = pending[0].earnedAt;
  const periodEnd = pending[pending.length - 1].earnedAt;

  const payout = await prisma.$transaction(async (tx) => {
    const p = await tx.payout.create({
      data: {
        businessId,
        cleanerId,
        periodStart,
        periodEnd,
        totalCents,
        method: method || null,
        reference: reference || null,
        createdBy: actorUserId,
      },
    });
    await tx.cleanerEarning.updateMany({
      where: { id: { in: pending.map((e) => e.id) } },
      data: { status: 'IN_PAYOUT', payoutId: p.id },
    });
    return p;
  });

  await audit({
    businessId,
    actorUserId,
    action: 'PAYOUT_CREATED',
    entityType: 'Payout',
    entityId: payout.id,
    metadata: { cleanerId, totalCents, earningsCount: pending.length },
  });

  return payout;
}

async function markPayoutPaid(businessId, actorUserId, payoutId, { method, reference } = {}) {
  const payout = await prisma.payout.findFirst({ where: { id: payoutId, businessId } });
  if (!payout) {
    const err = new Error('Payout not found for this business');
    err.status = 404;
    throw err;
  }
  if (payout.status === 'PAID') {
    return payout; // idempotent
  }
  if (payout.status === 'CANCELED') {
    const err = new Error('Cannot mark a canceled payout as paid');
    err.status = 422;
    throw err;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.payout.update({
      where: { id: payoutId },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        method: method || payout.method,
        reference: reference || payout.reference,
      },
    });
    await tx.cleanerEarning.updateMany({ where: { payoutId }, data: { status: 'PAID' } });
    return p;
  });

  await audit({ businessId, actorUserId, action: 'PAYOUT_MARKED_PAID', entityType: 'Payout', entityId: payoutId });

  return updated;
}

async function listPayouts(businessId, { cleanerId, status } = {}) {
  return prisma.payout.findMany({
    where: { businessId, ...(cleanerId ? { cleanerId } : {}), ...(status ? { status } : {}) },
    include: { cleaner: { select: { id: true, userId: true, user: { select: { firstName: true, lastName: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
}

module.exports = {
  setCompensation,
  listCompensations,
  computeEarningsForBooking,
  listEarnings,
  getMyEarningsSummary,
  getEarningsSummaryByCleanerId,
  createPayout,
  markPayoutPaid,
  listPayouts,
};
