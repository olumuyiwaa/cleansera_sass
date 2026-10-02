jest.mock('../src/config/database.js', () => ({
  supportTicket: { count: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  supportTicketMessage: { create: jest.fn() },
  business: { findUnique: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn() },
  customer: { findFirst: jest.fn() },
  booking: { findFirst: jest.fn() },
  businessMember: { findMany: jest.fn() },
  platformInquiry: { count: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  auditLog: { create: jest.fn().mockResolvedValue({}) },
}));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/lib/notificationClient', () => ({ isEmailConfigured: jest.fn(), sendEmail: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ notifyMembers: jest.fn() }));

const prisma = require('../src/config/database.js');
const mail = require('../src/lib/notificationClient');
const notifications = require('../src/modules/notifications/notifications.service');
const tickets = require('../src/modules/supportTickets/supportTickets.service');
const inquiries = require('../src/modules/platformInquiries/platformInquiries.service');
const { toPublicBusiness } = require('../src/modules/widget/widget.service');
const { updateBusiness } = require('../src/modules/businesses/businesses.service');

const env = { ...process.env };
const business = { id: 'biz1', name: 'Sparkle BV', contactEmail: null };
const visitor = { name: 'Anna', email: 'Anna@Example.com', phone: '06 12345678', message: 'Do you clean offices on weekends?' };

beforeEach(() => {
  jest.resetAllMocks();
  prisma.auditLog.create.mockResolvedValue({});
  mail.isEmailConfigured.mockReturnValue(true);
  mail.sendEmail.mockResolvedValue(undefined);
  prisma.supportTicket.count.mockResolvedValue(0);
  prisma.supportTicket.create.mockImplementation(async ({ data }) => ({ id: 'cmticket0000abcdef12', ...data }));
  prisma.businessMember.findMany.mockResolvedValue([]);
});
afterEach(() => { process.env = { ...env }; });

describe('createWebsiteTicket (storefront contact form)', () => {
  test('creates a WEBSITE ticket scoped to the business with normalised contact details', async () => {
    const out = await tickets.createWebsiteTicket(business, visitor);
    const data = prisma.supportTicket.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      businessId: 'biz1', source: 'WEBSITE', status: 'OPEN',
      contactName: 'Anna', contactEmail: 'anna@example.com', contactPhone: '06 12345678',
      description: 'Do you clean offices on weekends?',
    });
    expect(out.reference).toBe('T-ABCDEF12');
  });

  test('emails the business contact address with Reply-To set to the visitor', async () => {
    await tickets.createWebsiteTicket({ ...business, contactEmail: 'office@sparkle.nl' }, visitor);
    const staff = mail.sendEmail.mock.calls.map((c) => c[0]).find((m) => m.to === 'office@sparkle.nl');
    expect(staff).toBeTruthy();
    expect(staff.replyTo).toBe('anna@example.com');
    expect(staff.text).toContain('Do you clean offices on weekends?');
  });

  test('falls back to active owners and managers when no contact email is set', async () => {
    prisma.businessMember.findMany.mockResolvedValue([
      { user: { email: 'owner@sparkle.nl', isActive: true } },
      { user: { email: 'gone@sparkle.nl', isActive: false } },
    ]);
    await tickets.createWebsiteTicket(business, visitor);
    const where = prisma.businessMember.findMany.mock.calls[0][0].where;
    expect(where.role.in).toEqual(['BUSINESS_OWNER', 'BUSINESS_MANAGER']);
    const recipients = mail.sendEmail.mock.calls.map((c) => c[0].to);
    expect(recipients).toContain('owner@sparkle.nl');
    expect(recipients).not.toContain('gone@sparkle.nl');
  });

  test('acknowledges the visitor, with the business contact as Reply-To when set', async () => {
    await tickets.createWebsiteTicket({ ...business, contactEmail: 'office@sparkle.nl' }, visitor);
    const ack = mail.sendEmail.mock.calls.map((c) => c[0]).find((m) => m.to === 'anna@example.com');
    expect(ack.replyTo).toBe('office@sparkle.nl');
    expect(ack.subject).toMatch(/We received your message/);
  });

  test('notifies the business in the app', async () => {
    await tickets.createWebsiteTicket(business, visitor);
    expect(notifications.notifyMembers).toHaveBeenCalledWith('biz1', 'SUPPORT_TICKET', expect.any(String), expect.stringContaining('Anna'));
  });

  test('caps messages per address per day with a 429', async () => {
    prisma.supportTicket.count.mockResolvedValue(5);
    await expect(tickets.createWebsiteTicket(business, visitor)).rejects.toMatchObject({ status: 429 });
    expect(prisma.supportTicket.create).not.toHaveBeenCalled();
    const where = prisma.supportTicket.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ businessId: 'biz1', source: 'WEBSITE', contactEmail: 'anna@example.com' });
  });

  test('still succeeds when email is not configured or notifications fail', async () => {
    mail.isEmailConfigured.mockReturnValue(false);
    notifications.notifyMembers.mockRejectedValue(new Error('socket down'));
    await expect(tickets.createWebsiteTicket(business, visitor)).resolves.toHaveProperty('reference');
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  test('a name with a line break cannot inject mail headers into the subject', async () => {
    await tickets.createWebsiteTicket({ ...business, contactEmail: 'office@sparkle.nl' }, { ...visitor, name: 'Eve\r\nBcc: victim@x.nl' });
    for (const [m] of mail.sendEmail.mock.calls) expect(m.subject).not.toMatch(/[\r\n]/);
  });
});

describe('addMessage (staff reply emailed to the customer)', () => {
  const ticket = { id: 'cmticket0000abcdef12', businessId: 'biz1', subject: 'Message from Anna', status: 'OPEN', contactEmail: 'anna@example.com' };
  beforeEach(() => {
    prisma.supportTicket.findFirst.mockResolvedValue(ticket);
    prisma.supportTicket.update.mockResolvedValue({});
    prisma.business.findUnique.mockResolvedValue({ name: 'Sparkle BV', contactEmail: 'office@sparkle.nl' });
    prisma.user.findUnique.mockResolvedValue({ email: 'staff@sparkle.nl' });
    prisma.supportTicketMessage.create.mockImplementation(async ({ data }) => ({ id: 'm1', ...data }));
  });

  test('a public reply is emailed with the business as Reply-To and marked emailed', async () => {
    const msg = await tickets.addMessage('biz1', ticket.id, 'u1', { body: 'Yes, we do.', isInternal: false });
    const sent = mail.sendEmail.mock.calls[0][0];
    expect(sent).toMatchObject({ to: 'anna@example.com', replyTo: 'office@sparkle.nl' });
    expect(sent.text).toContain('Yes, we do.');
    expect(msg.emailedAt).toBeInstanceOf(Date);
  });

  test('without a business contact email, Reply-To is the replying staff member', async () => {
    prisma.business.findUnique.mockResolvedValue({ name: 'Sparkle BV', contactEmail: null });
    await tickets.addMessage('biz1', ticket.id, 'u1', { body: 'Hi', isInternal: false });
    expect(mail.sendEmail.mock.calls[0][0].replyTo).toBe('staff@sparkle.nl');
  });

  test('an internal note is never emailed', async () => {
    const msg = await tickets.addMessage('biz1', ticket.id, 'u1', { body: 'call her back', isInternal: true });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(msg.emailedAt).toBeNull();
  });

  test('a ticket with no contact email sends nothing and says so (emailedAt null)', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue({ ...ticket, contactEmail: null });
    const msg = await tickets.addMessage('biz1', ticket.id, 'u1', { body: 'Hi', isInternal: false });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(msg.emailedAt).toBeNull();
  });

  test('no mail provider configured => not claimed as emailed', async () => {
    mail.isEmailConfigured.mockReturnValue(false);
    const msg = await tickets.addMessage('biz1', ticket.id, 'u1', { body: 'Hi', isInternal: false });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(msg.emailedAt).toBeNull();
  });

  test('a send failure does not lose the reply and is not claimed as emailed', async () => {
    mail.sendEmail.mockRejectedValue(new Error('smtp down'));
    const msg = await tickets.addMessage('biz1', ticket.id, 'u1', { body: 'Hi', isInternal: false });
    expect(prisma.supportTicketMessage.create).toHaveBeenCalled();
    expect(msg.emailedAt).toBeNull();
  });
});

describe('tenant isolation of ticket references', () => {
  test('createTicket rejects a customer from another business and never prefills from it', async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(tickets.createTicket('biz1', 'u1', { subject: 's', description: 'd', customerId: 'otherTenantCust' }))
      .rejects.toMatchObject({ status: 422 });
    expect(prisma.customer.findFirst.mock.calls[0][0].where).toEqual({ id: 'otherTenantCust', businessId: 'biz1' });
    expect(prisma.supportTicket.create).not.toHaveBeenCalled();
  });

  test('createTicket prefills contact details from the business own customer', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: 'c1', firstName: 'Bram', lastName: 'de Vries', email: 'Bram@x.nl', phone: '+31611111111' });
    await tickets.createTicket('biz1', 'u1', { subject: 's', description: 'd', customerId: 'c1' });
    expect(prisma.supportTicket.create.mock.calls[0][0].data).toMatchObject({
      contactName: 'Bram de Vries', contactEmail: 'bram@x.nl', contactPhone: '+31611111111',
    });
  });

  test('an anonymised customer placeholder is not copied as a phone number', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: 'c1', firstName: 'x', lastName: 'y', email: null, phone: 'deleted-abc123' });
    await tickets.createTicket('biz1', 'u1', { subject: 's', description: 'd', customerId: 'c1' });
    expect(prisma.supportTicket.create.mock.calls[0][0].data.contactPhone).toBeNull();
  });

  test('updateTicket rejects a booking from another business', async () => {
    prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', businessId: 'biz1' });
    prisma.booking.findFirst.mockResolvedValue(null);
    await expect(tickets.updateTicket('biz1', 't1', 'u1', { bookingId: 'otherTenantBooking' })).rejects.toMatchObject({ status: 422 });
    expect(prisma.supportTicket.update).not.toHaveBeenCalled();
  });
});

describe('public storefront payload', () => {
  const row = { id: 'biz1', name: 'Sparkle', subdomain: 'sparkle', timezone: 'Europe/Amsterdam', currency: 'eur',
    contactEmail: 'private@sparkle.nl', contactPhone: '+31 20 123 4567', hours: [], branding: {} };

  test('exposes the phone number but NEVER the private contact email', () => {
    const pub = toPublicBusiness(row);
    expect(pub.phone).toBe('+31 20 123 4567');
    expect(JSON.stringify(pub)).not.toContain('private@sparkle.nl');
    expect(pub).not.toHaveProperty('contactEmail');
  });

  test('phone is null when not set', () => {
    expect(toPublicBusiness({ ...row, contactPhone: null }).phone).toBeNull();
  });
});

describe('updateBusiness contact fields', () => {
  beforeEach(() => {
    prisma.business.findUnique.mockResolvedValue({ id: 'biz1', currency: 'eur' });
    prisma.business.update.mockImplementation(async ({ data }) => data);
  });

  test('stores a normalised contact email and phone', async () => {
    await updateBusiness('biz1', { contactEmail: ' Office@Sparkle.NL ', contactPhone: ' +31 20 123 4567 ' });
    expect(prisma.business.update.mock.calls[0][0].data).toMatchObject({ contactEmail: 'office@sparkle.nl', contactPhone: '+31 20 123 4567' });
  });

  test('blank clears them', async () => {
    await updateBusiness('biz1', { contactEmail: '', contactPhone: '  ' });
    expect(prisma.business.update.mock.calls[0][0].data).toMatchObject({ contactEmail: null, contactPhone: null });
  });

  test.each([[{ contactEmail: 'not-an-email' }], [{ contactPhone: 'call me maybe' }]])('rejects %j with 422', async (patch) => {
    await expect(updateBusiness('biz1', patch)).rejects.toMatchObject({ status: 422 });
  });
});

describe('platform inbox (marketing site forms)', () => {
  beforeEach(() => {
    process.env.PLATFORM_INBOX_EMAIL = 'team@cleansera.nl, sales@cleansera.nl';
    prisma.platformInquiry.count.mockResolvedValue(0);
    prisma.platformInquiry.create.mockImplementation(async ({ data }) => ({ id: 'i1', ...data }));
    prisma.platformInquiry.update.mockResolvedValue({});
  });
  const input = { kind: 'SUPPORT', name: 'Pieter', email: 'P@Firm.nl', subject: 'Invoice', category: 'billing', message: 'My invoice shows the wrong VAT.' };

  test('stores the inquiry, emails every inbox address with Reply-To the sender, and acknowledges', async () => {
    const { reference } = await inquiries.createInquiry(input);
    expect(reference).toMatch(/^S-[0-9A-F]{10}$/);
    expect(prisma.platformInquiry.create.mock.calls[0][0].data).toMatchObject({ kind: 'SUPPORT', email: 'p@firm.nl', subject: 'Invoice' });
    const sent = mail.sendEmail.mock.calls.map((c) => c[0]);
    expect(sent.filter((m) => m.replyTo === 'p@firm.nl').map((m) => m.to).sort()).toEqual(['sales@cleansera.nl', 'team@cleansera.nl']);
    expect(sent.find((m) => m.to === 'p@firm.nl').subject).toContain(reference);
    expect(prisma.platformInquiry.update.mock.calls[0][0].data).toMatchObject({ notifiedAt: expect.any(Date), ackSentAt: expect.any(Date) });
  });

  test('demo requests get a D- reference', async () => {
    const { reference } = await inquiries.createInquiry({ ...input, kind: 'DEMO' });
    expect(reference).toMatch(/^D-/);
  });

  test('is saved even when no inbox address is configured', async () => {
    delete process.env.PLATFORM_INBOX_EMAIL;
    await expect(inquiries.createInquiry(input)).resolves.toHaveProperty('reference');
    expect(prisma.platformInquiry.create).toHaveBeenCalled();
  });

  test('caps messages per address per day with a 429', async () => {
    prisma.platformInquiry.count.mockResolvedValue(5);
    await expect(inquiries.createInquiry(input)).rejects.toMatchObject({ status: 429 });
    expect(prisma.platformInquiry.create).not.toHaveBeenCalled();
  });

  test('status updates are validated and 404 for unknown ids', async () => {
    await expect(inquiries.setInquiryStatus('i1', 'BOGUS', 'u1')).rejects.toMatchObject({ status: 422 });
    prisma.platformInquiry.findUnique.mockResolvedValue(null);
    await expect(inquiries.setInquiryStatus('nope', 'RESOLVED', 'u1')).rejects.toMatchObject({ status: 404 });
  });
});
