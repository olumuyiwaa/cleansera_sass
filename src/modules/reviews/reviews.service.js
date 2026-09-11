const prisma = require('../../config/database');

async function listReviews(businessId, { cleanerId } = {}) {
  return prisma.review.findMany({
    where: { businessId, ...(cleanerId ? { cleanerId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

module.exports = { listReviews };

async function createReview(businessId, payload) {
  // Manually-logged reviews (e.g. backfilled from an external channel) may
  // not specify which cleaner did the job — infer it the same way the
  // customer portal does, from the booking's most recent assignment,
  // unless the caller already provided one explicitly.
  let cleanerId = payload.cleanerId;
  if (!cleanerId && payload.bookingId) {
    const assignment = await prisma.bookingAssignment.findFirst({
      where: { bookingId: payload.bookingId },
      orderBy: { assignedAt: 'desc' },
    });
    cleanerId = assignment?.cleanerId || null;
  }
  const created = await prisma.review.create({ data: { businessId, ...payload, cleanerId } });
  return created;
}

async function getReview(businessId, id) {
  const r = await prisma.review.findFirst({ where: { id, businessId } });
  if (!r) {
    const err = new Error('Review not found');
    err.status = 404;
    throw err;
  }
  return r;
}

async function deleteReview(businessId, id) {
  await getReview(businessId, id);
  await prisma.review.delete({ where: { id } });
}

module.exports = { listReviews, createReview, getReview, deleteReview };
