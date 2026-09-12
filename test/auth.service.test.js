/**
 * These mocks previously used require.cache injection, which does not
 * actually intercept anything under Jest (Jest keeps its own module
 * registry, separate from Node's native require.cache — see
 * test/cancellationPolicy.test.js for the full explanation). That meant
 * this suite either failed outright in any environment without a
 * generated Prisma client, or — in an environment with one — silently ran
 * auth.service against the *real* database/notification/speakeasy modules
 * while asserting against mock objects nothing ever called, without ever
 * actually failing loudly because the calls it awaited resolved to
 * whatever the real modules happened to return. jest.mock() is the
 * technique that actually replaces the module.
 */
jest.mock('../src/config/database.js', () => ({
  user: { findUnique: jest.fn(), update: jest.fn() },
  passwordReset: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  otpCode: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  session: { deleteMany: jest.fn() },
  auditLog: { create: jest.fn() },
}));
jest.mock('../src/lib/notificationClient.js', () => ({
  sendEmail: jest.fn(),
  sendSms: jest.fn(),
  _sendEmailNow: jest.fn(),
}));
jest.mock('speakeasy', () => ({
  generateSecret: jest.fn(() => ({ base32: 'BASE32', otpauth_url: 'otpauth://x' })),
  totp: { verify: jest.fn() },
}));

const mockPrisma = require('../src/config/database.js');
const mockNotif = require('../src/lib/notificationClient.js');
const mockSpeakeasy = require('speakeasy');
const authService = require('../src/modules/auth/auth.service');

describe('auth.service password reset and 2FA', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('requestPasswordReset sends email when user exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
    mockPrisma.passwordReset.create.mockResolvedValue({ id: 'pr1' });

    await authService.requestPasswordReset('a@b.com');

    expect(mockPrisma.passwordReset.create).toHaveBeenCalled();
    expect(mockNotif.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.com' }));
  });

  test('confirmPasswordReset updates password when token valid', async () => {
    const pr = { id: 'pr1', userId: 'u1', expiresAt: new Date(Date.now() + 10000), usedAt: null };
    mockPrisma.passwordReset.findUnique.mockResolvedValue(pr);
    mockPrisma.user.update.mockResolvedValue({ id: 'u1' });
    mockPrisma.passwordReset.update.mockResolvedValue({});
    mockPrisma.session.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.auditLog.create.mockResolvedValue({});

    await authService.confirmPasswordReset('token123', 'newpass');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' } }));
    expect(mockPrisma.passwordReset.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: pr.id } }));
    // A password reset should invalidate existing sessions — otherwise a
    // stolen session token would survive the very reset meant to kill it.
    expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  test('generate2FASecret stores secret and returns urls', async () => {
    mockPrisma.user.update.mockResolvedValue({});
    const out = await authService.generate2FASecret('u1');
    expect(out.base32).toBe('BASE32');
    expect(mockPrisma.user.update).toHaveBeenCalled();
  });

  test('verifyAndEnable2FA verifies token and enables 2FA', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', twoFactorSecret: 'BASE32' });
    mockSpeakeasy.totp.verify.mockReturnValue(true);
    mockPrisma.user.update.mockResolvedValue({});
    await authService.verifyAndEnable2FA('u1', '123456');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' }, data: { twoFactorEnabled: true } }));
  });
});
