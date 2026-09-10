const service = require('./pricing.service');
const { success } = require('../../utils/response');

async function getPricing(req, res, next) {
  try {
    const p = await service.getPricing(req.businessId);
    return success(res, 200, p);
  } catch (e) {
    next(e);
  }
}

async function updatePricing(req, res, next) {
  try {
    const payload = { frequencyDiscounts: req.body.frequencyDiscounts };
    const updated = await service.updatePricing(req.businessId, payload);
    return success(res, 200, updated, 'Pricing updated');
  } catch (e) {
    next(e);
  }
}

async function listCoupons(req, res, next) {
  try {
    const rows = await service.listCoupons(req.businessId);
    return success(res, 200, rows);
  } catch (e) {
    next(e);
  }
}

async function createCoupon(req, res, next) {
  try {
    const created = await service.createCoupon(req.businessId, req.body);
    return success(res, 201, created, 'Coupon created');
  } catch (e) {
    next(e);
  }
}

async function updateCoupon(req, res, next) {
  try {
    const updated = await service.updateCoupon(req.businessId, req.params.id, req.body);
    return success(res, 200, updated, 'Coupon updated');
  } catch (e) {
    next(e);
  }
}

async function deleteCoupon(req, res, next) {
  try {
    const updated = await service.deleteCoupon(req.businessId, req.params.id);
    return success(res, 200, updated, 'Coupon deactivated');
  } catch (e) {
    next(e);
  }
}

module.exports = {
  getPricing,
  updatePricing,
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
};