/**
 * Cleaner-facing booking routes (aliases matching the Flutter app contract).
 *
 * Mount in src/routes/index.js (or equivalent) as:
 *   router.use('/bookings', require('../modules/bookings/cleanerBookings.routes'));
 *
 * Or merge the handlers into the main bookings router carefully so
 * /bookings/my is registered BEFORE /bookings/:id.
 *
 * Expected Flutter contract:
 *   GET  /bookings/my?from=&to=&status=
 *   GET  /bookings/:id
 *   POST /bookings/:id/check-in   { lat?, lng? }
 *   POST /bookings/:id/start
 *   POST /bookings/:id/complete  { lat?, lng?, notes? }
 */

const express = require('express');
const { body } = require('express-validator');
const prisma = require('../../config/database');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { success } = require('../../utils/response');
const bookingsService = require('./bookings.service');
const cleanersService = require('../cleaners/cleaners.service');

const router = express.Router();

router.use(authenticate);

/** Resolve ACTIVE cleaner profile for the logged-in user (any business). */
async function requireActiveCleaner(req, res, next) {
  try {
    const cleaner = await prisma.cleanerProfile.findFirst({
      where: { userId: req.user.id, status: 'ACTIVE' },
      include: { business: true },
    });
    if (!cleaner) {
      const err = new Error('Active cleaner profile not found');
      err.status = 403;
      throw err;
    }
    req.cleaner = cleaner;
    req.businessId = cleaner.businessId;
    next();
  } catch (err) {
    next(err);
  }
}

router.use(requireActiveCleaner);

/**
 * GET /bookings/my
 * List jobs assigned to this cleaner.
 */
router.get('/my', async (req, res, next) => {
  try {
    const { from, to, status } = req.query;
    const where = {
      assignments: { some: { cleanerId: req.cleaner.id } },
      businessId: req.cleaner.businessId,
    };
    if (status) where.status = status;
    if (from || to) {
      where.scheduledStart = {};
      if (from) where.scheduledStart.gte = new Date(from);
      if (to) where.scheduledStart.lte = new Date(to);
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        customer: true,
        service: true,
        assignments: {
          where: { cleanerId: req.cleaner.id },
        },
        checklist: true,
      },
      orderBy: { scheduledStart: 'asc' },
      take: 100,
    });

    return success(res, 200, bookings);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /bookings/:id
 * Job detail — only if this cleaner is assigned.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: {
        id: req.params.id,
        businessId: req.cleaner.businessId,
        assignments: { some: { cleanerId: req.cleaner.id } },
      },
      include: {
        customer: true,
        service: { include: { addOns: true } },
        assignments: { where: { cleanerId: req.cleaner.id } },
        checklist: true,
        photos: true,
      },
    });
    if (!booking) {
      const err = new Error('Booking not found or not assigned to you');
      err.status = 404;
      throw err;
    }
    return success(res, 200, booking);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /bookings/:id/check-in
 * Body: { lat?, lng? }
 * Resolves assignment for this cleaner and calls clockIn.
 */
router.post(
  '/:id/check-in',
  [body('lat').optional().isFloat(), body('lng').optional().isFloat()],
  validate,
  async (req, res, next) => {
    try {
      const assignment = await prisma.bookingAssignment.findFirst({
        where: { bookingId: req.params.id, cleanerId: req.cleaner.id },
      });
      if (!assignment) {
        const err = new Error('You are not assigned to this booking');
        err.status = 403;
        throw err;
      }

      const result = await cleanersService.clockIn(
        req.cleaner.businessId,
        req.cleaner.id,
        assignment.id,
        req.user.id,
        { lat: req.body.lat, lng: req.body.lng }
      );
      return success(res, 200, result, 'Checked in');
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /bookings/:id/start
 * Alias for check-in when the app separates "arrive" vs "start".
 * If already checked in, just ensures status is IN_PROGRESS.
 */
router.post('/:id/start', async (req, res, next) => {
  try {
    const assignment = await prisma.bookingAssignment.findFirst({
      where: { bookingId: req.params.id, cleanerId: req.cleaner.id },
      include: { booking: true },
    });
    if (!assignment) {
      const err = new Error('You are not assigned to this booking');
      err.status = 403;
      throw err;
    }

    if (!assignment.checkedInAt) {
      const result = await cleanersService.clockIn(
        req.cleaner.businessId,
        req.cleaner.id,
        assignment.id,
        req.user.id,
        { lat: req.body?.lat, lng: req.body?.lng }
      );
      return success(res, 200, result, 'Started');
    }

    if (assignment.booking.status !== 'IN_PROGRESS') {
      await prisma.booking.update({
        where: { id: req.params.id },
        data: { status: 'IN_PROGRESS' },
      });
    }

    return success(res, 200, assignment, 'Already started');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /bookings/:id/complete
 * Body: { lat?, lng?, notes? }
 */
router.post(
  '/:id/complete',
  [body('lat').optional().isFloat(), body('lng').optional().isFloat(), body('notes').optional().isString()],
  validate,
  async (req, res, next) => {
    try {
      const updated = await bookingsService.completeBookingByCleaner(req.params.id, req.user.id, {
        lat: req.body.lat,
        lng: req.body.lng,
        notes: req.body.notes,
      });
      return success(res, 200, updated, 'Booking completed');
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
