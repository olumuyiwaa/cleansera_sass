jest.mock('../src/config/database.js', () => ({
  businessSubscription: { findUnique: jest.fn() },
  business: { findUnique: jest.fn() },
  subscriptionPlan: { findFirst: jest.fn() },
}));

const prisma = require('../src/config/database.js');
const access = require('../src/lib/subscriptionAccess');
const { requireActiveSubscription, requireAcceptingBookings } = require('../src/middleware/requireActiveSubscription');
const { hasPlanFeature } = require('../src/lib/planFeatures');

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-06-15T12:00:00Z');
const ago = (d) => new Date(now.getTime() - d * DAY);
const ahead = (d) => new Date(now.getTime() + d * DAY);

describe('evaluate()', () => {
  test('no subscription row: 14-day platform trial from creation, then locked', () => {
    expect(access.evaluate(null, { createdAt: ago(3) }, now)).toMatchObject({ allowed: true, state: 'PLATFORM_TRIAL' });
    expect(access.evaluate(null, { createdAt: ago(15) }, now)).toMatchObject({ allowed: false, state: 'TRIAL_EXPIRED' });
  });
  test('TRIALING respects trialEndsAt with a day of slack', () => {
    expect(access.evaluate({ status: 'TRIALING', trialEndsAt: ahead(2) }, null, now).allowed).toBe(true);
    expect(access.evaluate({ status: 'TRIALING', trialEndsAt: ago(0.5) }, null, now).allowed).toBe(true);
    expect(access.evaluate({ status: 'TRIALING', trialEndsAt: ago(3) }, null, now).allowed).toBe(false);
  });
  test('ACTIVE is allowed, unless cancelled and the paid period has ended', () => {
    expect(access.evaluate({ status: 'ACTIVE' }, null, now).allowed).toBe(true);
    expect(access.evaluate({ status: 'ACTIVE', canceledAt: ago(10), currentPeriodEnd: ago(1) }, null, now).allowed).toBe(false);
    expect(access.evaluate({ status: 'ACTIVE', canceledAt: ago(1), currentPeriodEnd: ahead(10) }, null, now).allowed).toBe(true);
  });
  test('PAST_DUE has a grace window after the period end', () => {
    expect(access.evaluate({ status: 'PAST_DUE', currentPeriodEnd: ago(3) }, null, now).allowed).toBe(true);
    expect(access.evaluate({ status: 'PAST_DUE', currentPeriodEnd: ago(8) }, null, now).allowed).toBe(false);
  });
  test('CANCELED keeps access only for the period already paid', () => {
    expect(access.evaluate({ status: 'CANCELED', currentPeriodEnd: ahead(5) }, null, now).allowed).toBe(true);
    expect(access.evaluate({ status: 'CANCELED', currentPeriodEnd: ago(1) }, null, now).allowed).toBe(false);
    expect(access.evaluate({ status: 'CANCELED', currentPeriodEnd: null }, null, now).allowed).toBe(false);
  });
});

describe('enforcement toggle', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; access.clearCache(); jest.clearAllMocks(); });

  test('off by default outside production (no DB access at all)', async () => {
    delete process.env.SUBSCRIPTION_ENFORCEMENT;
    process.env.NODE_ENV = 'test';
    await expect(access.getAccess('b1')).resolves.toMatchObject({ allowed: true, state: 'ENFORCEMENT_OFF' });
    expect(prisma.businessSubscription.findUnique).not.toHaveBeenCalled();
  });
  test('on by default in production', () => {
    delete process.env.SUBSCRIPTION_ENFORCEMENT;
    process.env.NODE_ENV = 'production';
    expect(access.enforcementEnabled()).toBe(true);
  });
  test('explicit override wins', () => {
    process.env.NODE_ENV = 'production';
    process.env.SUBSCRIPTION_ENFORCEMENT = 'off';
    expect(access.enforcementEnabled()).toBe(false);
  });
});

describe('effective plan / feature gating with enforcement on', () => {
  const env = { ...process.env };
  beforeEach(() => { process.env.SUBSCRIPTION_ENFORCEMENT = 'on'; });
  afterEach(() => { process.env = { ...env }; jest.clearAllMocks(); });

  test('a business with no subscription is limited to the cheapest plan, not unlimited', async () => {
    prisma.businessSubscription.findUnique.mockResolvedValue(null);
    prisma.subscriptionPlan.findFirst.mockResolvedValue({ name: 'Starter', maxCleaners: 5, features: { customDomain: false, autoDispatch: false } });
    expect((await access.getEffectivePlan('b1')).maxCleaners).toBe(5);
    await expect(hasPlanFeature('b1', 'customDomain')).resolves.toBe(false);
    await expect(hasPlanFeature('b1', 'someUnlistedKey')).resolves.toBe(true);
  });
  test('a paid plan uses its own features', async () => {
    prisma.businessSubscription.findUnique.mockResolvedValue({ plan: { features: { customDomain: true } } });
    await expect(hasPlanFeature('b1', 'customDomain')).resolves.toBe(true);
  });
});

describe('middleware', () => {
  const env = { ...process.env };
  beforeEach(() => { process.env.SUBSCRIPTION_ENFORCEMENT = 'on'; access.clearCache(); });
  afterEach(() => { process.env = { ...env }; jest.clearAllMocks(); });

  const mkRes = () => { const res = {}; res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res); return res; };
  const lapsed = () => {
    prisma.businessSubscription.findUnique.mockResolvedValue({ status: 'CANCELED', currentPeriodEnd: ago(2) });
  };

  test('lapsed business: writes are blocked with 402 + code, reads pass', async () => {
    lapsed();
    const res = mkRes(); const next = jest.fn();
    await requireActiveSubscription({ method: 'POST', baseUrl: '/api/v1/bookings', businessId: 'b1', user: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(JSON.stringify(res.json.mock.calls[0][0])).toContain('SUBSCRIPTION_REQUIRED');
    expect(next).not.toHaveBeenCalled();

    const next2 = jest.fn();
    await requireActiveSubscription({ method: 'GET', baseUrl: '/api/v1/bookings', businessId: 'b1', user: {} }, mkRes(), next2);
    expect(next2).toHaveBeenCalled();
  });
  test('billing, support and notifications stay reachable when locked', async () => {
    lapsed();
    for (const baseUrl of ['/api/v1/subscriptions', '/api/v1/support-tickets', '/api/v1/notifications']) {
      const next = jest.fn();
      await requireActiveSubscription({ method: 'POST', baseUrl, businessId: 'b1', user: {} }, mkRes(), next);
      expect(next).toHaveBeenCalled();
    }
  });
  test('super admin is never blocked', async () => {
    lapsed();
    const next = jest.fn();
    await requireActiveSubscription({ method: 'POST', baseUrl: '/api/v1/bookings', businessId: 'b1', user: { globalRole: 'SUPER_ADMIN' } }, mkRes(), next);
    expect(next).toHaveBeenCalled();
  });
  test('public widget stops taking bookings for a lapsed business', async () => {
    lapsed();
    const res = mkRes(); const next = jest.fn();
    await requireAcceptingBookings({ businessId: 'b1' }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  test('active business passes the widget check', async () => {
    prisma.businessSubscription.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    const next = jest.fn();
    await requireAcceptingBookings({ businessId: 'b2' }, mkRes(), next);
    expect(next).toHaveBeenCalled();
  });
});
