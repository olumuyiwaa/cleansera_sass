const crypto = require('crypto');
const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { oneLine, sendTracked } = require('../../lib/contactMail');

const KINDS = ['SUPPORT', 'DEMO'];
const STATUSES = ['NEW', 'IN_PROGRESS', 'RESOLVED', 'SPAM'];
const PER_EMAIL_PER_DAY = 5;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** "S-1A2B3C4D5E" / "D-..." - random, so references are not guessable or sequential. */
function newReference(kind) {
  return `${kind === 'DEMO' ? 'D' : 'S'}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

/** Addresses that receive platform inquiries: PLATFORM_INBOX_EMAIL (comma-separated). */
function inboxRecipients() {
  return String(process.env.PLATFORM_INBOX_EMAIL || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * A message from the marketing site (support form or demo request). Stored as a
 * PlatformInquiry so it can be seen and worked in the admin inbox, then emailed
 * to the team and acknowledged to the sender. The email steps are best-effort:
 * the record is saved first and is the source of truth.
 */
async function createInquiry({ kind, name, email, company, phone, subject, category, message, source }) {
  if (!KINDS.includes(kind)) throw httpError(500, 'Unknown inquiry kind');

  const data = {
    kind,
    name: oneLine(name, 100),
    email: String(email).trim().toLowerCase(),
    company: oneLine(company, 150) || null,
    phone: oneLine(phone, 40) || null,
    subject: oneLine(subject, 150) || null,
    category: oneLine(category, 50) || null,
    message: message ? String(message).trim().slice(0, 5000) : null,
    source: oneLine(source, 60) || 'website',
  };

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await prisma.platformInquiry.count({
    where: { kind, email: data.email, createdAt: { gte: since } },
  });
  if (recent >= PER_EMAIL_PER_DAY) {
    throw httpError(429, 'You have sent several messages today. We will reply to them as soon as we can.');
  }

  let inquiry;
  for (let attempt = 0; ; attempt += 1) {
    try {
      inquiry = await prisma.platformInquiry.create({ data: { ...data, reference: newReference(kind) } });
      break;
    } catch (err) {
      // Unique reference collision (vanishingly rare): retry once with a new one.
      if (err.code === 'P2002' && attempt < 1) continue;
      throw err;
    }
  }

  try {
    const label = kind === 'DEMO' ? 'Demo request' : 'Support message';
    const lines = [
      `${label} from ${data.name} <${data.email}>`,
      data.company ? `Company:   ${data.company}` : null,
      data.phone ? `Phone:     ${data.phone}` : null,
      data.category ? `Category:  ${data.category}` : null,
      data.subject ? `Subject:   ${data.subject}` : null,
      `Reference: ${inquiry.reference}`,
      '',
      data.message || '(no message)',
      '',
      '--',
      'Reply to this email to answer them directly. It is also in the admin inbox.',
    ].filter((l) => l !== null);

    const recipients = inboxRecipients();
    if (!recipients.length) {
      logger.warn('PLATFORM_INBOX_EMAIL is not set: inquiry saved but nobody was emailed', { reference: inquiry.reference });
    }
    let notified = false;
    for (const to of recipients) {
      const sent = await sendTracked({
        to,
        subject: `${label}: ${data.subject || data.name} [${inquiry.reference}]`,
        text: lines.join('\n'),
        replyTo: data.email,
      });
      notified = notified || sent;
    }

    const acked = await sendTracked({
      to: data.email,
      subject: `We received your message [${inquiry.reference}]`,
      text: [
        `Hi ${data.name},`,
        '',
        kind === 'DEMO'
          ? 'Thanks for your interest in CleanSera. We have your request and will be in touch.'
          : 'Thanks for contacting CleanSera support. We have your message and will reply by email.',
        `Your reference is ${inquiry.reference}.`,
      ].join('\n'),
    });

    if (notified || acked) {
      await prisma.platformInquiry.update({
        where: { id: inquiry.id },
        data: { ...(notified ? { notifiedAt: new Date() } : {}), ...(acked ? { ackSentAt: new Date() } : {}) },
      });
    }
  } catch (err) {
    logger.error('platform inquiry follow-up failed', { reference: inquiry.reference, error: err.message });
  }

  return { reference: inquiry.reference };
}

async function listInquiries({ status, kind, q, page = 1, limit = 20 } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const where = {};
  if (STATUSES.includes(status)) where.status = status;
  if (KINDS.includes(kind)) where.kind = kind;
  if (q) {
    where.OR = [
      { name: { contains: String(q), mode: 'insensitive' } },
      { email: { contains: String(q), mode: 'insensitive' } },
      { company: { contains: String(q), mode: 'insensitive' } },
      { reference: { contains: String(q), mode: 'insensitive' } },
    ];
  }
  const [total, data, newCount] = await Promise.all([
    prisma.platformInquiry.count({ where }),
    prisma.platformInquiry.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (pageNum - 1) * take, take }),
    prisma.platformInquiry.count({ where: { status: 'NEW' } }),
  ]);
  return {
    data,
    newCount,
    pagination: { page: pageNum, limit: take, total, totalPages: Math.ceil(total / take) || 1 },
  };
}

async function setInquiryStatus(id, status, actorUserId) {
  if (!STATUSES.includes(status)) throw httpError(422, 'Invalid status');
  const existing = await prisma.platformInquiry.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Inquiry not found');
  return prisma.platformInquiry.update({
    where: { id },
    data: { status, handledBy: actorUserId || existing.handledBy },
  });
}

module.exports = { createInquiry, listInquiries, setInquiryStatus, KINDS, STATUSES };
