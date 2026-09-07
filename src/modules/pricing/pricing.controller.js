const service = require('./pricing.service');

async function getPricing(req, res, next) {
  try {
    const p = await service.getPricing(req.businessId);
    res.json(p);
  } catch (e) { next(e); }
}

async function updatePricing(req, res, next) {
  try {
    const payload = { frequencyDiscounts: req.body.frequencyDiscounts };
    const updated = await service.updatePricing(req.businessId, payload);
    res.json(updated);
  } catch (e) { next(e); }
}

async function listCoupons(req, res, next) {
  try {
    const rows = await service.listCoupons(req.businessId);
    res.json(rows);
  } catch (e) { next(e); }
}

async function createCoupon(req, res, next) {
  try {
    const payload = req.body;
    const created = await service.createCoupon(req.businessId, payload);
    res.json(created);
  } catch (e) { next(e); }
}

async function updateCoupon(req, res, next) {
  try {
    const id = req.params.id;
    const updated = await service.updateCoupon(req.businessId, id, req.body);
    res.json(updated);
  } catch (e) { next(e); }
}

async function deleteCoupon(req, res, next) {
  try {
    const id = req.params.id;
    const updated = await service.deleteCoupon(req.businessId, id);
    res.json(updated);
  } catch (e) { next(e); }
}

module.exports = { getPricing, updatePricing, listCoupons, createCoupon, updateCoupon, deleteCoupon };
