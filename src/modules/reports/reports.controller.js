const service = require('./reports.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const data = await service.generateSummary(req.businessId);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function kpis(req, res, next) {
  try {
    const data = await service.generateKPIs(req.businessId, { from: req.query.from, to: req.query.to });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function revenue(req, res, next) {
  try {
    const data = await service.revenueByDay(req.businessId, { from: req.query.from, to: req.query.to });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function cleanerPerf(req, res, next) {
  try {
    const data = await service.cleanerPerformance(req.businessId, { from: req.query.from, to: req.query.to });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, kpis, revenue, cleanerPerf };
