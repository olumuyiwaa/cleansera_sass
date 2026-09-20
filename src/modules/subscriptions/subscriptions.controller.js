const service = require('./subscriptions.service');
const { success } = require('../../utils/response');

async function listPlans(req, res, next) {
  try {
    const plans = await service.listPlans();
    return success(res, 200, plans);
  } catch (err) {
    next(err);
  }
}

async function getAccess(req, res, next) {
  try {
    const { getAccess: compute, enforcementEnabled } = require('../../lib/subscriptionAccess');
    const access = await compute(req.businessId);
    return success(res, 200, { ...access, enforced: enforcementEnabled() });
  } catch (err) {
    next(err);
  }
}

async function getSubscription(req, res, next) {
  try {
    const sub = await service.getSubscriptionForBusiness(req.businessId);
    return success(res, 200, sub);
  } catch (err) {
    next(err);
  }
}

async function updateSubscription(req, res, next) {
  try {
    const s = await service.updateSubscriptionForBusiness(req.businessId, { planId: req.body.planId });
    return success(res, 200, s, 'Subscription updated');
  } catch (err) {
    next(err);
  }
}

async function createSubscription(req, res, next) {
  try {
    const result = await service.createSubscriptionForBusiness(req.businessId, { planId: req.body.planId });
    return success(res, 201, result, 'Continue to checkout to start your subscription');
  } catch (err) {
    next(err);
  }
}

async function cancelSubscription(req, res, next) {
  try {
    const s = await service.cancelSubscriptionForBusiness(req.businessId);
    return success(res, 200, s, 'Subscription canceled');
  } catch (err) {
    next(err);
  }
}

async function createPortalSession(req, res, next) {
  try {
    const result = await service.createPortalSession(req.businessId);
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function listInvoices(req, res, next) {
  try {
    const invoices = await service.listInvoicesForBusiness(req.businessId);
    return success(res, 200, invoices);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAccess,
  listPlans,
  getSubscription,
  updateSubscription,
  createSubscription,
  cancelSubscription,
  createPortalSession,
  listInvoices,
};