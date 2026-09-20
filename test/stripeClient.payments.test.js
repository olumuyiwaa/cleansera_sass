jest.mock('../src/config/database.js', () => ({ business: { update: jest.fn() } }));
const mockStripe = {
  refunds: { create: jest.fn().mockResolvedValue({ id: 're_1' }) },
  checkout: { sessions: { create: jest.fn().mockResolvedValue({ id: 'cs_1', url: 'u' }) } },
  accounts: { create: jest.fn().mockResolvedValue({ id: 'acct_1' }) },
  accountLinks: { create: jest.fn().mockResolvedValue({ url: 'l' }) },
  transfers: { create: jest.fn().mockResolvedValue({ id: 'tr_1' }) },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
const client = require('../src/lib/stripeClient');

describe('stripeClient payments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CHECKOUT_PAYMENT_METHODS;
    delete process.env.DEFAULT_CURRENCY;
    delete process.env.PLATFORM_COUNTRY;
  });

  test('refunds reverse the transfer so the business, not the platform, bears the refund', async () => {
    await client.createRefund({ paymentIntentId: 'pi_1', amountCents: 500 });
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_1', amount: 500, reverse_transfer: true }));
  });

  test('EUR checkout offers iDEAL alongside cards', async () => {
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000, currency: 'eur' });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_method_types).toEqual(['card', 'ideal']);
  });

  test('non-EUR checkout drops EUR-only methods', async () => {
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000, currency: 'usd' });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_method_types).toEqual(['card']);
  });

  test('the default currency is EUR and is configurable', async () => {
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000 });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.currency).toBe('eur');
    process.env.DEFAULT_CURRENCY = 'gbp';
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000 });
    expect(mockStripe.checkout.sessions.create.mock.calls[1][0].line_items[0].price_data.currency).toBe('gbp');
  });

  test('connect onboarding does not force business_type company', async () => {
    await client.createConnectAccountAndLink({ id: 'b1', name: 'N' }, { refreshUrl: 'r', returnUrl: 'x' });
    const arg = mockStripe.accounts.create.mock.calls[0][0];
    expect(arg.business_type).toBeUndefined();
    expect(arg.type).toBe('express');
  });

  test('payout transfers carry an idempotency key so a retry cannot pay twice', async () => {
    await client.payCleanerTransfer({ businessConnectedAccountId: 'a', cleanerConnectedAccountId: 'c', amountCents: 100, payoutId: 'po1' });
    expect(mockStripe.transfers.create.mock.calls[0][1]).toMatchObject({ stripeAccount: 'a', idempotencyKey: 'payout_po1' });
  });
});
