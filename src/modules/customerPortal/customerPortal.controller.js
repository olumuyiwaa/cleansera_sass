const service = require('./customerPortal.service');
const { success } = require('../../utils/response');

async function requestAccess(req, res, next) {
  try {
    const data = await service.requestAccess(req.businessId, req.body);
    return success(res, 200, data, 'If an account exists, a code was sent');
  } catch (err) {
    next(err);
  }
}

async function verifyAccess(req, res, next) {
  try {
    const data = await service.verifyAccess(req.businessId, req.body);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function listBookings(req, res, next) {
  try {
    const data = await service.listMyBookings(req.businessId, req.portalCustomerId);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function getBooking(req, res, next) {
  try {
    const data = await service.getMyBooking(req.businessId, req.portalCustomerId, req.params.id);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function cancelBooking(req, res, next) {
  try {
    const data = await service.cancelMyBooking(req.businessId, req.portalCustomerId, req.params.id, req.body.reason);
    return success(res, 200, data, 'Booking cancelled');
  } catch (err) {
    next(err);
  }
}

async function rescheduleBooking(req, res, next) {
  try {
    const data = await service.rescheduleMyBooking(req.businessId, req.portalCustomerId, req.params.id, req.body);
    return success(res, 200, data, 'Booking rescheduled');
  } catch (err) {
    next(err);
  }
}

async function leaveReview(req, res, next) {
  try {
    const data = await service.leaveReview(req.businessId, req.portalCustomerId, req.params.id, req.body);
    return success(res, 201, data, 'Review submitted');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  requestAccess,
  verifyAccess,
  listBookings,
  getBooking,
  cancelBooking,
  rescheduleBooking,
  leaveReview,
};
