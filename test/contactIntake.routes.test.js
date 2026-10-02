jest.mock('../src/config/database.js', () => ({}));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Rate limiting and captcha have their own tests; here they are transparent so the
// route logic (validation, honeypot, response shape) is what is exercised.
const pass = (req, res, next) => next();
jest.mock('../src/middleware/rateLimiter', () => ({
  widgetLimiter: (q, s, n) => n(),
  widgetSubmitLimiter: (q, s, n) => n(),
  publicFormLimiter: (q, s, n) => n(),
}));
jest.mock('../src/lib/captcha', () => ({ requireCaptcha: () => (q, s, n) => n() }));
jest.mock('../src/middleware/requireActiveSubscription', () => ({ requireAcceptingBookings: (q, s, n) => n() }));
const mockBusiness = { id: 'biz1', name: 'Sparkle BV', contactEmail: null };
jest.mock('../src/middleware/resolveBusinessFromHost', () => ({
  resolveBusinessFromHost: (req, res, next) => { req.businessId = 'biz1'; req.business = mockBusiness; next(); },
}));
jest.mock('../src/middleware/resolveBusinessFromSlug', () => ({
  resolveBusinessFromSlug: (req, res, next) => { req.businessId = 'biz1'; req.business = mockBusiness; next(); },
}));
jest.mock('../src/modules/widget/widget.service', () => ({}));
jest.mock('../src/modules/supportTickets/supportTickets.service', () => ({ createWebsiteTicket: jest.fn() }));
jest.mock('../src/modules/platformInquiries/platformInquiries.service', () => ({ createInquiry: jest.fn() }));

const express = require('express');
const request = require('supertest');
const tickets = require('../src/modules/supportTickets/supportTickets.service');
const inquiries = require('../src/modules/platformInquiries/platformInquiries.service');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/widget', require('../src/modules/widget/widget.routes'));
  a.use('/support', require('../src/modules/supportContact/supportContact.routes'));
  a.use('/demo-requests', require('../src/modules/demoRequests/demoRequests.routes'));
  a.use((err, req, res, next) => res.status(err.status || 500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars
  return a;
}

const good = { name: 'Anna', email: 'anna@example.com', phone: '+31 6 12345678', message: 'Do you clean offices on weekends?' };
beforeEach(() => jest.resetAllMocks());

describe('POST /widget/contact (storefront)', () => {
  test('201 with a reference, passing the resolved business (never client input) to the service', async () => {
    tickets.createWebsiteTicket.mockResolvedValue({ reference: 'T-ABCDEF12' });
    const res = await request(app()).post('/widget/contact').send({ ...good, businessId: 'attacker-biz' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ reference: 'T-ABCDEF12' });
    const [bizArg] = tickets.createWebsiteTicket.mock.calls[0];
    expect(bizArg).toBe(mockBusiness);
  });

  test.each([
    ['missing name', { ...good, name: '' }, 'name'],
    ['bad email', { ...good, email: 'nope' }, 'email'],
    ['message too short', { ...good, message: 'hi' }, 'message'],
    ['message too long', { ...good, message: 'x'.repeat(3001) }, 'message'],
    ['bad phone', { ...good, phone: 'call me' }, 'phone'],
  ])('422 for %s, and nothing is stored', async (_n, payload, field) => {
    const res = await request(app()).post('/widget/contact').send(payload);
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e) => e.field)).toContain(field);
    expect(tickets.createWebsiteTicket).not.toHaveBeenCalled();
  });

  test('phone is optional', async () => {
    tickets.createWebsiteTicket.mockResolvedValue({ reference: 'T-X' });
    const { phone, ...noPhone } = good; // eslint-disable-line no-unused-vars
    expect((await request(app()).post('/widget/contact').send(noPhone)).status).toBe(201);
  });

  test('a filled honeypot looks like success but stores and sends nothing', async () => {
    const res = await request(app()).post('/widget/contact').send({ ...good, website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(res.body.data.reference).toMatch(/^T-[0-9A-Z]{8}$/);
    expect(tickets.createWebsiteTicket).not.toHaveBeenCalled();
  });

  test('a per-address daily cap from the service surfaces as 429', async () => {
    tickets.createWebsiteTicket.mockRejectedValue(Object.assign(new Error('Too many today'), { status: 429 }));
    const res = await request(app()).post('/widget/contact').send(good);
    expect(res.status).toBe(429);
  });

  test('also reachable on the slug-based router', async () => {
    tickets.createWebsiteTicket.mockResolvedValue({ reference: 'T-SLUG' });
    const a = express();
    a.use(express.json());
    a.use('/widget-embed/:subdomain', require('../src/modules/widget/widget.routes').slugRouter);
    expect((await request(a).post('/widget-embed/sparkle/contact').send(good)).status).toBe(201);
  });
});

describe('POST /support (marketing support form)', () => {
  const payload = { name: 'Pieter', email: 'p@firm.nl', subject: 'Invoice', category: 'billing', message: 'My invoice shows the wrong VAT.' };

  test('201 with received + reference; every field is passed through as a SUPPORT inquiry', async () => {
    inquiries.createInquiry.mockResolvedValue({ reference: 'S-0123456789' });
    const res = await request(app()).post('/support').send(payload);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ received: true, reference: 'S-0123456789' });
    expect(inquiries.createInquiry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SUPPORT', subject: 'Invoice', category: 'billing' }));
  });

  test.each([
    ['message too short', { ...payload, message: 'short' }],
    ['message over 5000', { ...payload, message: 'x'.repeat(5001) }],
    ['subject over 150', { ...payload, subject: 'x'.repeat(151) }],
    ['bad email', { ...payload, email: 'x' }],
  ])('422 for %s', async (_n, p) => {
    expect((await request(app()).post('/support').send(p)).status).toBe(422);
    expect(inquiries.createInquiry).not.toHaveBeenCalled();
  });

  test('honeypot is silently dropped', async () => {
    const res = await request(app()).post('/support').send({ ...payload, website: 'x' });
    expect(res.status).toBe(201);
    expect(inquiries.createInquiry).not.toHaveBeenCalled();
  });
});

describe('POST /demo-requests (marketing demo form)', () => {
  test('201, stored as a DEMO inquiry, message optional, reference returned', async () => {
    inquiries.createInquiry.mockResolvedValue({ reference: 'D-0123456789' });
    const res = await request(app()).post('/demo-requests').send({ name: 'Sam', email: 's@clean.nl', company: 'Clean BV' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ received: true, reference: 'D-0123456789' });
    expect(inquiries.createInquiry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'DEMO', company: 'Clean BV' }));
  });

  test('422 for an oversized message and for a bad email', async () => {
    expect((await request(app()).post('/demo-requests').send({ name: 'S', email: 's@c.nl', message: 'x'.repeat(3001) })).status).toBe(422);
    expect((await request(app()).post('/demo-requests').send({ name: 'S', email: 'bad' })).status).toBe(422);
  });
});
