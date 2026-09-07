const service = require('./widget.service');
const { success } = require('../../utils/response');

async function storefront(req, res, next) {
  try {
    const data = await service.getStorefront(req.businessId);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function quote(req, res, next) {
  try {
    const data = await service.quote(req.businessId, req.body);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function slots(req, res, next) {
  try {
    const data = await service.slots(req.businessId, req.query);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function submitBooking(req, res, next) {
  try {
    const booking = await service.submitBooking(req.businessId, req.body);
    return success(res, 201, booking, 'Booking request received');
  } catch (err) {
    next(err);
  }
}

module.exports = { storefront, quote, submitBooking };
