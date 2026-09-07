const service = require('./checklists.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const checklists = await service.listChecklists(req.businessId);
    return success(res, 200, checklists);
  } catch (err) {
    next(err);
  }
}

module.exports = { list };

async function get(req, res, next) {
  try {
    const c = await service.getChecklist(req.businessId, req.params.bookingId);
    return success(res, 200, c);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const created = await service.createChecklist(req.businessId, req.body.bookingId, req.body.items);
    return success(res, 201, created, 'Checklist created');
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const updated = await service.updateChecklist(req.businessId, req.params.bookingId, req.body.items);
    return success(res, 200, updated, 'Checklist updated');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteChecklist(req.businessId, req.params.bookingId);
    return success(res, 200, null, 'Checklist deleted');
  } catch (err) {
    next(err);
  }
}

module.exports.get = get;
module.exports.create = create;
module.exports.update = update;
module.exports.remove = remove;
