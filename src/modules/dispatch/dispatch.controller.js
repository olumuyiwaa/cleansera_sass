const service = require('./dispatch.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const items = await service.listDispatchItems(req.businessId);
    return success(res, 200, items);
  } catch (err) {
    next(err);
  }
}

async function createAssignment(req, res, next) {
  try {
    const a = await service.createAssignment(req.businessId, req.body.bookingId, req.body.cleanerId, req.user.id);
    return success(res, 201, a, 'Assignment created');
  } catch (err) {
    next(err);
  }
}

async function getAssignment(req, res, next) {
  try {
    const a = await service.getAssignment(req.businessId, req.params.id);
    return success(res, 200, a);
  } catch (err) {
    next(err);
  }
}

async function removeAssignment(req, res, next) {
  try {
    await service.deleteAssignment(req.businessId, req.params.id);
    return success(res, 200, null, 'Assignment removed');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, createAssignment, getAssignment, removeAssignment };
