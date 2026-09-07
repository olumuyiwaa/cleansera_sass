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

  const existingProfile = await prisma.cleanerProfile.findUnique({ where: { userId: user.id } });
  if (existingProfile) {
    const err = new Error('This person already has a cleaner profile');
    err.status = 409;
    throw err;
  }

  const profile = await prisma.cleanerProfile.create({
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
    action: 'CLEANER_ONBOARDED',
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

module.exports = { onboardCleaner, offboardCleaner, listCleaners, setAvailability };
