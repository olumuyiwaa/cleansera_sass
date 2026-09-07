const service = require('./subscriptions.service');
const { success } = require('../../utils/response');

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
    const s = await service.updateSubscriptionForBusiness(req.businessId, req.body);
    return success(res, 200, s, 'Subscription updated');
  } catch (err) {
    next(err);
  }
}

async function createSubscription(req, res, next) {
  try {
    const s = await service.createSubscriptionForBusiness(req.businessId, req.body);
    return success(res, 201, s, 'Subscription created');
  } catch (err) {
    next(err);
  }
}

async function cancelSubscription(req, res, next) {
  try {
    await service.cancelSubscriptionForBusiness(req.businessId);
    return success(res, 200, null, 'Subscription canceled');
  } catch (err) {
    next(err);
  }
}

module.exports = { getSubscription, updateSubscription, createSubscription, cancelSubscription };
