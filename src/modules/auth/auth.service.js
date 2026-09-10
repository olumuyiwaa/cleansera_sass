const bcrypt = require('bcryptjs');
const prisma = require('../../config/database');
const { signAccessToken, signRefreshToken } = require('../../utils/jwt');
const { audit } = require('../../utils/audit');

const REFRESH_TTL_DAYS = 30;

const { v4: uuidv4 } = require('uuid');
const notificationClient = require('../../lib/notificationClient');
const speakeasy = require('speakeasy');
const prismaRaw = prisma; // keep naming

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

async function login({ email, password, twoFactorCode, userAgent, ipAddress }) {
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

  // 2FA was previously enable-able but never actually checked at sign-in —
  // a user could turn it on and it changed nothing about login. Enforce it
  // here: if enabled, a valid TOTP code is required before a session is
  // issued.
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

  // A user may belong to exactly one business as staff, or hold a cleaner
  // profile — resolve whichever applies so the token carries a businessId.
  const membership = await prisma.businessMember.findFirst({ where: { userId: user.id, isActive: true } });
  const cleanerProfile = membership
      ? null
      : await prisma.cleanerProfile.findFirst({ where: { userId: user.id, status: 'ACTIVE' } });

  const businessId = membership?.businessId || cleanerProfile?.businessId || null;

  return issueSession(user.id, businessId, { userAgent, ipAddress });
}

async function issueSession(userId, businessId, meta = {}) {
  const accessToken = signAccessToken({ userId, businessId });
  const refreshToken = signRefreshToken();

  await prisma.session.create({
    data: {
      userId,
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

  const membership = await prisma.businessMember.findFirst({ where: { userId: session.userId, isActive: true } });
  const cleanerProfile = membership
      ? null
      : await prisma.cleanerProfile.findFirst({ where: { userId: session.userId, status: 'ACTIVE' } });
  const businessId = membership?.businessId || cleanerProfile?.businessId || null;

  return issueSession(session.userId, businessId);
}

async function logout(refreshToken) {
  await prisma.session.deleteMany({ where: { refreshToken } });
}

module.exports = { registerBusiness, login, refresh, logout };

// ----------------------- Password reset / email verify / 2FA -----------------

async function requestPasswordReset(email) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return; // don't leak
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
  await prisma.passwordReset.create({ data: { userId: user.id, token, expiresAt } });
  const resetUrl = `${process.env.APP_URL || 'https://app.cleansera.example'}/auth/password-reset/confirm?token=${token}`;
  await notificationClient.sendEmail({ to: user.email, subject: 'Reset your password', text: `Reset link: ${resetUrl}` });
}

async function confirmPasswordReset(token, newPassword) {
  const pr = await prisma.passwordReset.findUnique({ where: { token }, include: { user: true } });
  if (!pr || pr.usedAt || pr.expiresAt < new Date()) {
    const err = new Error('Invalid or expired token');
    err.status = 400;
    throw err;
  }
  const hash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: pr.userId }, data: { passwordHash: hash } });
  await prisma.passwordReset.update({ where: { id: pr.id }, data: { usedAt: new Date() } });
  // A password reset should invalidate every existing session — otherwise a
  // session opened before a compromise (the likely reason for the reset)
  // just survives it.
  await prisma.session.deleteMany({ where: { userId: pr.userId } });
  await audit({ businessId: null, actorUserId: pr.userId, action: 'PASSWORD_RESET', entityType: 'User', entityId: pr.userId });
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
  await prisma.otpCode.create({ data: { userId, code, purpose: 'EMAIL_VERIFY', expiresAt } });
  await notificationClient.sendEmail({ to: user.email, subject: 'Verify your email', text: `Your verification code: ${code}` });
}

async function confirmEmailVerify(userId, code) {
  const otp = await prisma.otpCode.findFirst({ where: { userId, code, purpose: 'EMAIL_VERIFY', consumedAt: null } });
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
  // store secret but not enable until verified
  await prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: secret.base32 } });
  return { otpauth_url: secret.otpauth_url, base32: secret.base32 };
}

async function verifyAndEnable2FA(userId, token) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.twoFactorSecret) {
    const err = new Error('2FA not initialized');
    err.status = 400;
    throw err;
  }
  const ok = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token, window: 1 });
  if (!ok) {
    const err = new Error('Invalid 2FA token');
    err.status = 400;
    throw err;
  }
  await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
}

async function disable2FA(userId) {
  await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
}

/**
 * Assembles the `/auth/me` payload from the identity authenticate() already
 * resolved (req.user: id, globalRole, businessId, businessRole,
 * cleanerProfileId) plus the public User fields and, if applicable, the
 * business summary the frontend's CurrentUser type expects.
 */
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

module.exports.requestPasswordReset = requestPasswordReset;
module.exports.confirmPasswordReset = confirmPasswordReset;
module.exports.requestEmailVerify = requestEmailVerify;
module.exports.confirmEmailVerify = confirmEmailVerify;
module.exports.generate2FASecret = generate2FASecret;
module.exports.verifyAndEnable2FA = verifyAndEnable2FA;
module.exports.disable2FA = disable2FA;
module.exports.getCurrentUser = getCurrentUser;