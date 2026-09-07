const authService = require('./auth.service');
const { success, error } = require('../../utils/response');

async function register(req, res, next) {
  try {
    const tokens = await authService.registerBusiness(req.body);
    return success(res, 201, tokens, 'Business registered');
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const tokens = await authService.login({
      ...req.body,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    return success(res, 200, tokens, 'Logged in');
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return error(res, 400, 'refreshToken is required');
    const tokens = await authService.refresh(refreshToken);
    return success(res, 200, tokens, 'Token refreshed');
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    await authService.logout(req.body.refreshToken);
    return success(res, 200, null, 'Logged out');
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, refresh, logout };

async function requestPasswordReset(req, res, next) {
  try {
    await authService.requestPasswordReset(req.body.email);
    return success(res, 200, null, 'If an account exists, a reset email was sent');
  } catch (err) {
    next(err);
  }
}

async function confirmPasswordReset(req, res, next) {
  try {
    await authService.confirmPasswordReset(req.body.token, req.body.password);
    return success(res, 200, null, 'Password reset');
  } catch (err) {
    next(err);
  }
}

async function requestEmailVerify(req, res, next) {
  try {
    await authService.requestEmailVerify(req.user.id);
    return success(res, 200, null, 'Verification email sent');
  } catch (err) {
    next(err);
  }
}

async function confirmEmailVerify(req, res, next) {
  try {
    await authService.confirmEmailVerify(req.user.id, req.body.code);
    return success(res, 200, null, 'Email verified');
  } catch (err) {
    next(err);
  }
}

async function generate2FA(req, res, next) {
  try {
    const secret = await authService.generate2FASecret(req.user.id);
    return success(res, 200, secret);
  } catch (err) {
    next(err);
  }
}

async function verifyEnable2FA(req, res, next) {
  try {
    await authService.verifyAndEnable2FA(req.user.id, req.body.token);
    return success(res, 200, null, '2FA enabled');
  } catch (err) {
    next(err);
  }
}

async function disable2FA(req, res, next) {
  try {
    await authService.disable2FA(req.user.id);
    return success(res, 200, null, '2FA disabled');
  } catch (err) {
    next(err);
  }
}

module.exports.requestPasswordReset = requestPasswordReset;
module.exports.confirmPasswordReset = confirmPasswordReset;
module.exports.requestEmailVerify = requestEmailVerify;
module.exports.confirmEmailVerify = confirmEmailVerify;
module.exports.generate2FA = generate2FA;
module.exports.verifyEnable2FA = verifyEnable2FA;
module.exports.disable2FA = disable2FA;
