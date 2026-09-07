const service = require('./messaging.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const convos = await service.listConversations(req.businessId);
    return success(res, 200, convos);
  } catch (err) {
    next(err);
  }
}

async function createConversation(req, res, next) {
  try {
    const conv = await service.createConversation(req.businessId, req.body);
    return success(res, 201, conv, 'Conversation created');
  } catch (err) {
    next(err);
  }
}

async function postMessage(req, res, next) {
  try {
    const msg = await service.postMessage(req.businessId, req.params.id, req.user.id, req.body);
    return success(res, 201, msg, 'Message posted');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, createConversation, postMessage };
