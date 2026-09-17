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

async function giftCardBalance(req, res, next) {
  try {
    const data = await service.checkGiftCardBalance(req.businessId, req.params.code);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function joinWaitlist(req, res, next) {
  try {
    const waitlistService = require('../waitlist/waitlist.service');
    const entry = await waitlistService.joinWaitlist(req.businessId, req.body);
    return success(res, 201, entry, "You're on the waitlist — we'll reach out the moment a slot opens up");
  } catch (err) {
    next(err);
  }
}

module.exports = { storefront, quote, slots, submitBooking, giftCardBalance, joinWaitlist };