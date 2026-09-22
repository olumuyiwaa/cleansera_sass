const service = require('./domains.service');
const { success, error } = require('../../utils/response');

async function getStatus(req, res, next) {
  try {
    const data = await service.getStatus(req.businessId);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function setDomain(req, res, next) {
  try {
    const data = await service.setDomain(req.businessId, req.user.id, req.body.customDomain);
    return success(res, 200, data, 'Domain saved — add the TXT record to verify ownership');
  } catch (err) {
    if (err.status) return error(res, err.status, err.message);
    next(err);
  }
}

async function verifyNow(req, res, next) {
  try {
    const data = await service.verifyNow(req.businessId, req.user.id);
    if (data.status !== 'VERIFIED') {
      return error(res, 422, 'TXT record not found yet — DNS changes can take a few minutes to propagate', data);
    }
    return success(res, 200, data, 'Domain verified');
  } catch (err) {
    if (err.status) return error(res, err.status, err.message);
    next(err);
  }
}

async function removeDomain(req, res, next) {
  try {
    await service.removeDomain(req.businessId, req.user.id);
    return success(res, 200, null);
  } catch (err) {
    next(err);
  }
}

// Public — no auth, no businessId scope. Cache-Control lets a CDN/edge
// absorb most of the traffic; keep the TTL short so a freshly verified
// domain goes live within a minute rather than being stuck behind a stale
// negative cache entry.
async function resolvePublic(req, res, next) {
  try {
    // `host` is what the frontend middleware sends; `domain` is the query
    // param name Caddy's on_demand_tls `ask` hook uses — same endpoint
    // serves both callers.
    const host = String(req.query.host || req.query.domain || '');
    const subdomain = await service.resolvePublic(host);
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    if (!subdomain) {
      return error(res, 404, 'No verified business found for this domain');
    }
    return success(res, 200, { subdomain });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStatus, setDomain, verifyNow, removeDomain, resolvePublic };
