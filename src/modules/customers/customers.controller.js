const service = require('./customers.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const customers = await service.listCustomers(req.businessId);
    return success(res, 200, customers);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const c = await service.createCustomer(req.businessId, req.body);
    return success(res, 201, c, 'Customer created');
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const c = await service.getCustomer(req.businessId, req.params.id);
    return success(res, 200, c);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const c = await service.updateCustomer(req.businessId, req.params.id, req.body);
    return success(res, 200, c, 'Customer updated');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteCustomer(req.businessId, req.params.id);
    return success(res, 200, null, 'Customer deleted');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, get, update, remove };
