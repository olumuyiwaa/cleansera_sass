const nodemailer = require('nodemailer');
const twilio = require('twilio');
const sendgrid = require('@sendgrid/mail');
const logger = require('../config/logger');
let queue;
try {
  // optional dependency, only used when NOTIFICATION_QUEUE=true
  const q = require('./queue');
  queue = q.notificationQueue;
} catch (e) {
  // ignore
}

let transporter;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

let twClient;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

if (process.env.SENDGRID_API_KEY) {
  sendgrid.setApiKey(process.env.SENDGRID_API_KEY);
}

async function _sendEmailNow({ to, subject, text, html, from }) {
  from = from || process.env.EMAIL_FROM || 'no-reply@cleansera.example';
  if (process.env.SENDGRID_API_KEY) {
    try {
      return sendgrid.send({ to, from, subject, text, html });
    } catch (e) {
      logger.error('sendGrid send failed, falling back to SMTP', e);
    }
  }

  if (!transporter) {
    logger.info('sendEmail fallback (no SMTP or SendGrid):', { to, subject });
    return Promise.resolve();
  }

  return transporter.sendMail({ from, to, subject, text, html });
}

async function _sendSmsNow({ to, body }) {
  if (!twClient || !process.env.TWILIO_FROM) {
    logger.info('sendSms fallback (no Twilio):', { to, body });
    return Promise.resolve();
  }

  return twClient.messages.create({ body, from: process.env.TWILIO_FROM, to });
}

async function sendEmail(payload) {
  if (process.env.NOTIFICATION_QUEUE === 'true' && queue) {
    await queue.add('email', payload, { attempts: 5 });
    return { queued: true };
  }
  return _sendEmailNow(payload);
}

async function sendSms(payload) {
  if (process.env.NOTIFICATION_QUEUE === 'true' && queue) {
    await queue.add('sms', payload, { attempts: 5 });
    return { queued: true };
  }
  return _sendSmsNow(payload);
}

module.exports = { sendEmail, sendSms, _sendEmailNow, _sendSmsNow };
