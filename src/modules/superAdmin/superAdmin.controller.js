const service = require('./superAdmin.service');
const { success, error } = require('../../utils/response');

function parseBool(v) {
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  return undefined;
}

async function overview(req, res, next) {
  try {
    const data = await service.getOverview();
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function listBusinesses(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const isActive = parseBool(req.query.isActive);
    const data = await service.listBusinesses({
      q: req.query.q,
      isActive,
      page,
      limit,
    });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function getBusiness(req, res, next) {
  try {
    const data = await service.getBusiness(req.params.id);
    return success(res, 200, data);
  } catch (err) {
    if (err.status === 404) return error(res, 404, err.message);
    next(err);
  }
}

async function setBusinessActive(req, res, next) {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return error(res, 400, 'isActive (boolean) is required');
    }
    const data = await service.setBusinessActive(
      req.params.id,
      isActive,
      req.user.id
    );
    return success(
      res,
      200,
      data,
      isActive ? 'Business activated' : 'Business deactivated'
    );
  } catch (err) {
    if (err.status === 404) return error(res, 404, err.message);
    next(err);
  }
}

async function listSubscriptions(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const data = await service.listSubscriptions({
      status: req.query.status,
      page,
      limit,
    });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function listPlans(req, res, next) {
  try {
    const data = await service.listPlans();
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function listUsers(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const data = await service.listUsers({
      q: req.query.q,
      globalRole: req.query.globalRole,
      page,
      limit,
    });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function setUserActive(req, res, next) {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return error(res, 400, 'isActive (boolean) is required');
    }
    const data = await service.setUserActive(
      req.params.id,
      isActive,
      req.user.id
    );
    return success(
      res,
      200,
      data,
      isActive ? 'User activated' : 'User deactivated'
    );
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return error(res, err.status, err.message);
    }
    next(err);
  }
}

async function listTickets(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const data = await service.listTickets({
      status: req.query.status,
      page,
      limit,
    });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function updateTicketStatus(req, res, next) {
  try {
    const data = await service.updateTicketStatus(
      req.params.id,
      req.body.status,
      req.user.id
    );
    return success(res, 200, data, 'Ticket updated');
  } catch (err) {
    if (err.status === 404) return error(res, 404, err.message);
    next(err);
  }
}

async function listAuditLogs(req, res, next) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const data = await service.listAuditLogs({
      action: req.query.action,
      businessId: req.query.businessId,
      page,
      limit,
    });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  overview,
  listBusinesses,
  getBusiness,
  setBusinessActive,
  listSubscriptions,
  listPlans,
  listUsers,
  setUserActive,
  listTickets,
  updateTicketStatus,
  listAuditLogs,
};
