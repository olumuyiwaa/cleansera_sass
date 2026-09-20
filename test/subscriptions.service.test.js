jest.mock('../src/config/database.js', () => ({
  subscriptionPlan: { findUnique: jest.fn() },
  businessSubscription: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  businessMember: { findFirst: jest.fn() },
  cleanerProfile: { count: jest.fn() },
}));
jest.mock('../src/lib/stripeClient', () => ({
  createSubscriptionCheckoutSession: jest.fn(),
  changeSubscriptionPlan: jest.fn(),
  cancelSubscriptionAtPeriodEnd: jest.fn(),
  createBillingPortalSession: jest.fn(),
}));

const prisma = require('../src/config/database.js');
const stripeClient = require('../src/lib/stripeClient');
const service = require('../src/modules/subscriptions/subscriptions.service');

describe('subscriptions.service', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creating a subscription only returns a checkout URL and never writes a row', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue({ id: 'p1', isActive: true, stripePriceId: 'price_1' });
    prisma.businessSubscription.findUnique.mockResolvedValue(null);
    prisma.businessMember.findFirst.mockResolvedValue({ user: { email: 'o@x.nl' } });
    stripeClient.createSubscriptionCheckoutSession.mockResolvedValue({ url: 'https://checkout', id: 'cs_1' });

    const result = await service.createSubscriptionForBusiness('biz1', { planId: 'p1', stripeSubscriptionId: 'sub_evil', status: 'ACTIVE' });

    expect(result).toEqual({ checkoutUrl: 'https://checkout', sessionId: 'cs_1' });
    expect(prisma.businessSubscription.create).not.toHaveBeenCalled();
    const args = stripeClient.createSubscriptionCheckoutSession.mock.calls[0][0];
    expect(args.trialDays).toBe(14);
    expect(args.stripeSubscriptionId).toBeUndefined();
  });

  test('a business that already subscribed does not get a second trial', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue({ id: 'p1', isActive: true, stripePriceId: 'price_1' });
    prisma.businessSubscription.findUnique.mockResolvedValue({ id: 's1', status: 'CANCELED', stripeCustomerId: 'cus_1' });
    prisma.businessMember.findFirst.mockResolvedValue(null);
    stripeClient.createSubscriptionCheckoutSession.mockResolvedValue({ url: 'u', id: 'cs' });
    await service.createSubscriptionForBusiness('biz1', { planId: 'p1' });
    expect(stripeClient.createSubscriptionCheckoutSession.mock.calls[0][0]).toMatchObject({ trialDays: 0, stripeCustomerId: 'cus_1' });
  });

  test('refuses to start a second subscription while one is live', async () => {
    prisma.subscriptionPlan.findUnique.mockResolvedValue({ id: 'p1', isActive: true, stripePriceId: 'price_1' });
    prisma.businessSubscription.findUnique.mockResolvedValue({ id: 's1', status: 'ACTIVE' });
    await expect(service.createSubscriptionForBusiness('biz1', { planId: 'p1' })).rejects.toMatchObject({ status: 409 });
  });

  test('update only changes the plan and ignores status/period fields in the body', async () => {
    prisma.businessSubscription.findUnique.mockResolvedValue({ id: 's1', planId: 'p1', stripeSubscriptionId: 'sub_1' });
    prisma.subscriptionPlan.findUnique.mockResolvedValue({ id: 'p2', isActive: true, stripePriceId: 'price_2', maxCleaners: null });
    prisma.businessSubscription.update.mockResolvedValue({ id: 's1', planId: 'p2' });

    await service.updateSubscriptionForBusiness('biz1', { planId: 'p2', status: 'ACTIVE', currentPeriodEnd: '2099-01-01' });

    expect(stripeClient.changeSubscriptionPlan).toHaveBeenCalledWith('sub_1', 'price_2');
    expect(prisma.businessSubscription.update.mock.calls[0][0].data).toEqual({ planId: 'p2' });
  });

  test('blocks a downgrade below the current active cleaner count', async () => {
    prisma.businessSubscription.findUnique.mockResolvedValue({ id: 's1', planId: 'p2', stripeSubscriptionId: 'sub_1' });
    prisma.subscriptionPlan.findUnique.mockResolvedValue({ id: 'p1', name: 'Starter', isActive: true, stripePriceId: 'price_1', maxCleaners: 5 });
    prisma.cleanerProfile.count.mockResolvedValue(8);
    await expect(service.updateSubscriptionForBusiness('biz1', { planId: 'p1' })).rejects.toMatchObject({ status: 409 });
    expect(stripeClient.changeSubscriptionPlan).not.toHaveBeenCalled();
  });

  test('cancel is scheduled for period end rather than immediate', async () => {
    prisma.businessSubscription.findUnique.mockResolvedValue({ id: 's1', stripeSubscriptionId: 'sub_1' });
    prisma.businessSubscription.update.mockResolvedValue({ id: 's1' });
    await service.cancelSubscriptionForBusiness('biz1');
    expect(stripeClient.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith('sub_1');
    expect(prisma.businessSubscription.update.mock.calls[0][0].data.status).toBeUndefined();
  });
});
