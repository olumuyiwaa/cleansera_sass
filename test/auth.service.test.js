const path = require('path');

// Prepare mocks by injecting into require cache before loading the service
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const notifPath = path.resolve(__dirname, '../src/lib/notificationClient.js');
const speakeasyPath = require.resolve('speakeasy');

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  passwordReset: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  otpCode: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
};

const mockNotif = { sendEmail: jest.fn(), sendSms: jest.fn(), _sendEmailNow: jest.fn() };

const mockSpeakeasy = { generateSecret: jest.fn(() => ({ base32: 'BASE32', otpauth_url: 'otpauth://x' })), totp: { verify: jest.fn() } };

require.cache[dbPath] = { exports: mockPrisma };
require.cache[notifPath] = { exports: mockNotif };
require.cache[speakeasyPath] = { exports: mockSpeakeasy };

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

    await authService.confirmPasswordReset('token123', 'newpass');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' } }));
    expect(mockPrisma.passwordReset.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: pr.id } }));
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
