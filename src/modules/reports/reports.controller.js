const service = require('./reports.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const report = await service.generateSummary(req.businessId);
    return success(res, 200, report);
  } catch (err) {
    next(err);
  }
}

module.exports = { list };

async function kpis(req, res, next) {
  try {
    const k = await service.generateKPIs(req.businessId, { from: req.query.from, to: req.query.to });
    return success(res, 200, k);
  } catch (err) {
    next(err);
  }
}

module.exports.kpis = kpis;
