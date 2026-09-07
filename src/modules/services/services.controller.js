const service = require('./services.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const services = await service.listServices(req.businessId);
    return success(res, 200, services);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const s = await service.createService(req.businessId, req.body);
    return success(res, 201, s, 'Service created');
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const s = await service.getService(req.businessId, req.params.id);
    return success(res, 200, s);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const s = await service.updateService(req.businessId, req.params.id, req.body);
    return success(res, 200, s, 'Service updated');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteService(req.businessId, req.params.id);
    return success(res, 200, null, 'Service deleted');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, get, update, remove };
