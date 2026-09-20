jest.mock('../src/config/database.js', () => ({
  customer: { findUnique: jest.fn() },
  user: { findUnique: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
  otpCode: { count: jest.fn(), updateMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
}));
jest.mock('../src/lib/notificationClient', () => ({ sendSms: jest.fn(), sendEmail: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({ createRefund: jest.fn(), createAncillaryCheckoutSession: jest.fn() }));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../src/config/database.js');
const notificationClient = require('../src/lib/notificationClient');
const service = require('../src/modules/customerPortal/customerPortal.service');
const { requireCustomerPortal } = require('../src/modules/customerPortal/customerPortal.middleware');
const { authenticate } = require('../src/middleware/authenticate');

process.env.JWT_SECRET = 'test-secret';

const customer = { id: 'cust1', firstName: 'A', lastName: 'B', phone: '+31612345678', email: 'a@b.nl' };
const portalUser = { id: 'pu1', email: 'portal-cust1@portal.invalid' };
const hash = (userId, code) => crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');

describe('customerPortal access', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.customer.findUnique.mockResolvedValue(customer);
    prisma.user.findUnique.mockResolvedValue(portalUser);
  });

  test('never attaches the OTP to a User found by phone number', async () => {
    prisma.otpCode.count.mockResolvedValue(0);
    await service.requestAccess('biz1', { phone: customer.phone });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'portal-cust1@portal.invalid' } });
  });

  test('stores only a hash of the code and sends the plain code to the customer', async () => {
    prisma.otpCode.count.mockResolvedValue(0);
    await service.requestAccess('biz1', { phone: customer.phone });
    const stored = prisma.otpCode.create.mock.calls[0][0].data;
    const sms = notificationClient.sendSms.mock.calls[0][0].body;
    const plain = sms.match(/\d{6}/)[0];
    expect(stored.code).toBe(hash('pu1', plain));
    expect(stored.code).not.toContain(plain);
  });

  test('caps code requests per window without changing the response shape', async () => {
    prisma.otpCode.count.mockResolvedValue(3);
    const result = await service.requestAccess('biz1', { phone: customer.phone });
    expect(result).toEqual({ sent: true });
    expect(notificationClient.sendSms).not.toHaveBeenCalled();
    expect(prisma.otpCode.create).not.toHaveBeenCalled();
  });

  test('locks verification after repeated wrong guesses, even for the right code', async () => {
    prisma.otpCode.count.mockResolvedValue(5);
    await expect(service.verifyAccess('biz1', { phone: customer.phone, code: '123456' })).rejects.toMatchObject({ status: 429 });
    expect(prisma.otpCode.findFirst).not.toHaveBeenCalled();
    expect(prisma.otpCode.updateMany).toHaveBeenCalled();
  });

  test('records a failed attempt when the code is wrong', async () => {
    prisma.otpCode.count.mockResolvedValue(0);
    prisma.otpCode.findFirst.mockResolvedValue(null);
    await expect(service.verifyAccess('biz1', { phone: customer.phone, code: '000000' })).rejects.toMatchObject({ status: 401 });
    expect(prisma.otpCode.create.mock.calls[0][0].data.purpose).toBe('CUSTOMER_PORTAL_FAILED');
  });

  test('a correct code yields a portal-audience token bound to the customer', async () => {
    prisma.otpCode.count.mockResolvedValue(0);
    prisma.otpCode.findFirst.mockResolvedValue({ id: 'otp1' });
    const { token } = await service.verifyAccess('biz1', { phone: customer.phone, code: '123456' });
    const payload = jwt.verify(token, 'test-secret');
    expect(payload).toMatchObject({ sub: 'pu1', businessId: 'biz1', portalCustomerId: 'cust1', scope: 'CUSTOMER_PORTAL', aud: 'customer-portal' });
    expect(prisma.otpCode.findFirst.mock.calls[0][0].where.code).toBe(hash('pu1', '123456'));
  });
});

describe('portal tokens versus staff sessions', () => {
  const portalToken = () => jwt.sign(
    { sub: 'staff-user', businessId: 'biz1', portalCustomerId: 'c1', scope: 'CUSTOMER_PORTAL' },
    'test-secret', { audience: 'customer-portal' }
  );

  test('authenticate() rejects a portal token', async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await authenticate({ headers: { authorization: `Bearer ${portalToken()}` } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('requireCustomerPortal rejects an ordinary access token', () => {
    const access = jwt.sign({ sub: 'u1', businessId: 'biz1' }, 'test-secret');
    const next = jest.fn();
    requireCustomerPortal({ headers: { authorization: `Bearer ${access}` } }, {}, next);
    expect(next.mock.calls[0][0].status).toBe(401);
  });
});
