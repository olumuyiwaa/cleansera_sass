const express = require('express');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const { success } = require('../../utils/response');
const service = require('./invoices.service');
const prisma = require('../../config/database');

const router = express.Router();

// Invoices carry the customer's address and the business's tax identity:
// owners and managers only (cleaners must never see them).
router.use(authenticate, scopeToBusiness, requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'));

router.get('/', async (req, res, next) => {
  try {
    return success(res, 200, await service.listInvoices(req.businessId, req.query));
  } catch (err) { next(err); }
});

// Issue (idempotent) the invoice for a booking.
router.post('/booking/:bookingId', async (req, res, next) => {
  try {
    const inv = await service.issueForBooking(req.businessId, req.params.bookingId, req.user.id);
    return success(res, 201, inv);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    return success(res, 200, await service.getInvoice(req.businessId, req.params.id));
  } catch (err) { next(err); }
});

// Printable HTML. Fetch it with the Authorization header and open the result
// (a plain link cannot send the bearer token).
router.get('/:id/html', async (req, res, next) => {
  try {
    const inv = await service.getInvoice(req.businessId, req.params.id);
    const biz = await prisma.business.findUnique({ where: { id: req.businessId }, select: { timezone: true } });
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      // Inert document: inline styles only, no scripts, no framing.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return res.send(service.renderInvoiceHtml(inv, biz && biz.timezone));
  } catch (err) { next(err); }
});

module.exports = router;
