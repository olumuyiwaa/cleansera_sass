const bcrypt = require('bcryptjs');
const prisma = require('../../config/database');
const { signAccessToken, signRefreshToken } = require('../../utils/jwt');
const { audit } = require('../../utils/audit');

const REFRESH_TTL_DAYS = 30;

const { v4: uuidv4 } = require('uuid');
const notificationClient = require('../../lib/notificationClient');
const speakeasy = require('speakeasy');

/**
 * Registers a new cleaning business and its owner in one transaction.
 * This is the tenant-creation entry point — every business starts here.
 */
async function registerBusiness({ businessName, subdomain, firstName, lastName, email, phone, password }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const err = new Error('An account with this email already exists');
    err.status = 409;
    throw err;
  }

  const subdomainTaken = await prisma.business.findUnique({ where: { subdomain } });
  if (subdomainTaken) {
    const err = new Error('That subdomain is already taken');
    err.status = 409;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, phone, firstName, lastName, passwordHash, isEmailVerified: false },
    });

    const business = await tx.business.create({
      data: {
        name: businessName,
        subdomain,
        branding: { create: {} },
        hours: {
          create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            dayOfWeek,
            openTime: '08:00',
            closeTime: '18:00',
            isClosed: dayOfWeek === 0,
          })),
        },
      },
    });

    await tx.businessMember.create({
      data: { businessId: business.id, userId: user.id, role: 'BUSINESS_OWNER', joinedAt: new Date() },
    });

    return { user, business };
  });

  await audit({
    businessId: result.business.id,
    actorUserId: result.user.id,
    action: 'BUSINESS_REGISTERED',
    entityType: 'Business',
    entityId: result.business.id,
  });

  return issueSession(result.user.id, result.business.id);
}

async function login({ email, password, twoFactorCode, businessId, userAgent, ipAddress }) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }
  if (!user.isActive) {
    const err = new Error('This account has been deactivated');
    err.status = 403;
    throw err;
  }

  if (user.twoFactorEnabled) {
    if (!twoFactorCode) {
      const err = new Error('Two-factor authentication code required');
      err.status = 401;
      err.errors = { code: 'TWO_FACTOR_REQUIRED' };
      throw err;
    }
    const ok = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: twoFactorCode,
      window: 1,
    });
    if (!ok) {
      const err = new Error('Invalid two-factor authentication code');
      err.status = 401;
      err.errors = { code: 'TWO_FACTOR_INVALID' };
      throw err;
    }
  }

  // A user can be affiliated with more than one business now — as staff at
  // several businesses, a cleaner at several businesses, or both.
  const affiliations = await listAffiliations(user.id);

  if (affiliations.length > 1 && !businessId) {
    // Ambiguous — let the client show a "choose a workspace" screen.
    return { requiresBusinessSelection: true, affiliations };
  }

  const chosen = businessId
    ? affiliations.find((a) => a.businessId === businessId)
    : affiliations[0];
  if (businessId && !chosen) {
    const err = new Error('You are not affiliated with that business');
    err.status = 403;
    throw err;
  }

  return issueSession(user.id, chosen?.businessId || null, { userAgent, ipAddress });
}

/** Every business a user can currently act within, as staff and/or as a cleaner. */
async function listAffiliations(userId) {
  const [memberships, cleanerProfiles] = await Promise.all([
    prisma.businessMember.findMany({
      where: { userId, isActive: true },
      include: { business: { select: { id: true, name: true, subdomain: true } } },
    }),
    prisma.cleanerProfile.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { business: { select: { id: true, name: true, subdomain: true } } },
    }),
  ]);

  return [
    ...memberships.map((m) => ({
      businessId: m.businessId,
      businessName: m.business.name,
      subdomain: m.business.subdomain,
      role: m.role,
    })),
    ...cleanerProfiles.map((c) => ({
      businessId: c.businessId,
      businessName: c.business.name,
      subdomain: c.business.subdomain,
      role: 'CLEANER',
    })),
  ];
}

/** Re-issues a session for a specific business (after ambiguous login or mid-session switch). */
async function selectBusiness(userId, businessId, meta = {}) {
  const affiliations = await listAffiliations(userId);
  const chosen = affiliations.find((a) => a.businessId === businessId);
  if (!chosen) {
    const err = new Error('You are not affiliated with that business');
    err.status = 403;
    throw err;
  }
  return issueSession(userId, businessId, meta);
}

async function issueSession(userId, businessId, meta = {}) {
  const accessToken = signAccessToken({ userId, businessId });
  const refreshToken = signRefreshToken();

  await prisma.session.create({
    data: {
      userId,
      businessId, // pin the session to this workspace
      refreshToken,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });

  return { accessToken, refreshToken };
}

async function refresh(refreshToken) {
  const session = await prisma.session.findUnique({ where: { refreshToken } });
  if (!session || session.expiresAt < new Date()) {
    const err = new Error('Refresh token invalid or expired');
    err.status = 401;
    throw err;
  }

  await prisma.session.delete({ where: { id: session.id } }); // rotate

  // Stay in the same workspace this session was issued for.
  const affiliations = await listAffiliations(session.userId);
  const stillValid = session.businessId && affiliations.some((a) => a.businessId === session.businessId);
  const businessId = stillValid ? session.businessId : (affiliations[0]?.businessId || null);

  return issueSession(session.userId, businessId);
}

async function logout(refreshToken) {
  await prisma.session.deleteMany({ where: { refreshToken } });
}

async function requestPasswordReset(email) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60);
  await prisma.passwordReset.create({ data: { userId: user.id, token, expiresAt } });
  const resetUrl = `${process.env.APP_URL || 'https://app.cleansera.example'}/auth/password-reset/confirm?token=${token}`;
  await notificationClient.sendEmail({
    to: user.email,
    subject: 'Reset your password',
    text: `Reset link: ${resetUrl}`,
  });
}

async function confirmPasswordReset(token, newPassword) {
  const pr = await prisma.passwordReset.findUnique({
    where: { token },
    include: { user: true },
  });
  if (!pr || pr.usedAt || pr.expiresAt < new Date()) {
    const err = new Error('Invalid or expired token');
    err.status = 400;
    throw err;
  }
  const hash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: pr.userId }, data: { passwordHash: hash } });
  await prisma.passwordReset.update({ where: { id: pr.id }, data: { usedAt: new Date() } });
  await prisma.session.deleteMany({ where: { userId: pr.userId } });
  await audit({
    businessId: null,
    actorUserId: pr.userId,
    action: 'PASSWORD_RESET',
    entityType: 'User',
    entityId: pr.userId,
  });
}

async function requestEmailVerify(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 15);
  await prisma.otpCode.create({
    data: { userId, code, purpose: 'EMAIL_VERIFY', expiresAt },
  });
  await notificationClient.sendEmail({
    to: user.email,
    subject: 'Verify your email',
    text: `Your verification code: ${code}`,
  });
}

async function confirmEmailVerify(userId, code) {
  const otp = await prisma.otpCode.findFirst({
    where: { userId, code, purpose: 'EMAIL_VERIFY', consumedAt: null },
  });
  if (!otp || otp.expiresAt < new Date()) {
    const err = new Error('Invalid or expired code');
    err.status = 400;
    throw err;
  }
  await prisma.user.update({ where: { id: userId }, data: { isEmailVerified: true } });
  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
}

async function generate2FASecret(userId) {
  const secret = speakeasy.generateSecret({ length: 20 });
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: secret.base32 },
  });
  return { otpauth_url: secret.otpauth_url, base32: secret.base32 };
}

async function verifyAndEnable2FA(userId, token) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.twoFactorSecret) {
    const err = new Error('2FA not initialized');
    err.status = 400;
    throw err;
  }
  const ok = speakeasy.totp.verify({
    secret: user.twoFactorSecret,
    encoding: 'base32',
    token,
    window: 1,
  });
  if (!ok) {
    const err = new Error('Invalid 2FA token');
    err.status = 400;
    throw err;
  }
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: true },
  });
}

async function disable2FA(userId) {
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: false, twoFactorSecret: null },
  });
}

async function getCurrentUser({ id, globalRole, businessId, businessRole }) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      isEmailVerified: true,
      twoFactorEnabled: true,
      createdAt: true,
    },
  });
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const business = businessId
      ? await prisma.business.findUnique({
        where: { id: businessId },
        select: { id: true, name: true, subdomain: true, timezone: true },
      })
      : null;

  return { ...user, globalRole, businessId, businessRole, business };
}

async function updateCurrentUser(userId, { firstName, lastName, phone }) {
  const data = {};
  if (typeof firstName === 'string' && firstName.trim()) data.firstName = firstName.trim();
  if (typeof lastName === 'string' && lastName.trim()) data.lastName = lastName.trim();
  if (phone !== undefined) data.phone = phone ? String(phone).trim() : null;

  if (Object.keys(data).length === 0) {
    const err = new Error('No fields to update');
    err.status = 400;
    throw err;
  }

  return prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      isEmailVerified: true,
      twoFactorEnabled: true,
      createdAt: true,
    },
  });
}

async function changePassword(userId, { currentPassword, newPassword }) {
  if (!currentPassword || !newPassword) {
    const err = new Error('currentPassword and newPassword are required');
    err.status = 400;
    throw err;
  }
  if (String(newPassword).length < 8) {
    const err = new Error('New password must be at least 8 characters');
    err.status = 400;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    const err = new Error('Current password is incorrect');
    err.status = 401;
    throw err;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await prisma.session.deleteMany({ where: { userId } });
  return null;
}

// Single export object — do not assign module.exports more than once
module.exports = {
  registerBusiness,
  login,
  refresh,
  logout,
  requestPasswordReset,
  confirmPasswordReset,
  requestEmailVerify,
  confirmEmailVerify,
  generate2FASecret,
  verifyAndEnable2FA,
  disable2FA,
  getCurrentUser,
  updateCurrentUser,
  changePassword,
  listAffiliations,
  selectBusiness,
};
