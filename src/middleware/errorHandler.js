const logger = require('../config/logger');
const { error } = require('../utils/response');

function errorHandler(err, req, res, next) {
  logger.error(err.message, { stack: err.stack, path: req.path, businessId: req.businessId });

  if (err.code === 'P2002') return error(res, 409, `Duplicate value for ${err.meta?.target}`);
  if (err.code === 'P2025') return error(res, 404, 'Record not found');
  if (err.type === 'entity.parse.failed') return error(res, 400, 'Malformed JSON body');

  const status = err.status || 500;
  const message = status === 500 ? 'Internal server error' : err.message;
  return error(res, status, message);
}

module.exports = errorHandler;
