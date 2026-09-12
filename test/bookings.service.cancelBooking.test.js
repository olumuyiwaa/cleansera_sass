jest.mock('../src/config/database.js', () => ({
  booking: { findFirst: jest.fn(), update: jest.fn() },
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({
  notifyBookingCancelled: jest.fn(),
}));
jest.mock('../src/lib/stripeClient', () => ({
  createBookingCheckoutSession: jest.fn(),
  createAncillaryCheckoutSession: jest.fn(),
  createRefund: jest.fn(),
}));
jest.mock('../src/lib/cancellationPolicy', () => ({
  evaluateCancellation: jest.fn(),
}));

const mockPrisma = require('../src/config/database.js');
const { createRefund } = require('../src/lib/stripeClient');
const { evaluateCancellation } = require('../src/lib/cancellationPolicy');
const bookingsService = require('../src/modules/bookings/bookings.service');

describe('bookings.service.cancelBooking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const existingBooking = {
    id: 'bk1',
    status: 'CONFIRMED',
    quotedPriceCents: 10000,
    paymentStatus: 'PAID',
    amountPaidCents: 10000,
    stripePaymentIntentId: 'pi_job_123',
  };

  test('rejects cancelling an already-completed booking', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({ ...existingBooking, status: 'COMPLETED' });
    await expect(bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'changed my mind')).rejects.toThrow(
      /already COMPLETED/
    );
    expect(createRefund).not.toHaveBeenCalled();
  });

  test('issues a partial refund when the policy owes one, and records it on the booking', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(existingBooking);
    evaluateCancellation.mockResolvedValue({
      feeCents: 5000,
      refundCents: 5000,
      alreadyPaidCents: 10000,
      refundPaymentIntentId: 'pi_job_123',
    });
    createRefund.mockResolvedValue({ id: 're_123' });
    mockPrisma.booking.update.mockImplementation(({ data }) => ({ ...existingBooking, ...data }));

    const result = await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'schedule conflict');

    expect(createRefund).toHaveBeenCalledWith({
      paymentIntentId: 'pi_job_123',
      amountCents: 5000,
      reason: 'requested_by_customer',
    });
    expect(mockPrisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          cancellationFeeCents: 5000,
          refundedAmountCents: 5000,
          stripeRefundId: 're_123',
          paymentStatus: 'PARTIAL', // refund (5000) < total paid (10000)
        }),
      })
    );
    expect(result.status).toBe('CANCELLED');
  });

  test('waiveFee=true skips the policy entirely and issues no refund', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(existingBooking);
    mockPrisma.booking.update.mockImplementation(({ data }) => ({ ...existingBooking, ...data }));

    await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'business error', { waiveFee: true });

    expect(evaluateCancellation).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
    expect(mockPrisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cancellationFeeCents: null }) })
    );
  });

  test('a failed Stripe refund still cancels the booking, without recording a refund', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(existingBooking);
    evaluateCancellation.mockResolvedValue({
      feeCents: 0,
      refundCents: 10000,
      alreadyPaidCents: 10000,
      refundPaymentIntentId: 'pi_job_123',
    });
    createRefund.mockRejectedValue(new Error('stripe is down'));
    mockPrisma.booking.update.mockImplementation(({ data }) => ({ ...existingBooking, ...data }));

    const result = await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'reason');

    expect(result.status).toBe('CANCELLED');
    expect(mockPrisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ refundedAmountCents: expect.anything() }),
      })
    );
  });
});
