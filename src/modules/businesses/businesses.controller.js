const service = require('./businesses.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const businesses = await service.listBusinesses(req.businessId);
    return success(res, 200, businesses);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const b = await service.updateBusiness(req.businessId, req.body);
    return success(res, 200, b, 'Business updated');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, update };

module.exports = { list };
