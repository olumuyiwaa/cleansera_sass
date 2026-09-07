const prisma = require('../../config/database');

async function listReviews(businessId) {
  return prisma.review.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 200 });
}

module.exports = { listReviews };

async function createReview(businessId, payload) {
  const created = await prisma.review.create({ data: { businessId, ...payload } });
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
