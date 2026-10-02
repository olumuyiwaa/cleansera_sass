jest.mock('../src/config/database.js', () => ({}));
// Importing the services pulls in the notifications queue, which opens a Redis
// connection at import time and would keep jest from exiting.
jest.mock('../src/lib/queue', () => ({ enqueue: jest.fn(), sendEmail: jest.fn(), sendSms: jest.fn() }));
// A bare {} prisma stub makes any database access throw a TypeError, so these
// tests also prove the reserved check runs BEFORE any lookup.

const { RESERVED_SLUGS, isReservedSlug, assertSubdomainAllowed } = require('../src/lib/reservedSlugs');
const { registerBusiness } = require('../src/modules/auth/auth.service');
const { createLocation } = require('../src/modules/businesses/businesses.service');

describe('reserved subdomains', () => {
  test.each(['www', 'api', 'admin', 'app', 'team', 'bookings', 'calendar', 'portal', 'book-now', 'dashboard'])(
    '%s is reserved',
    (name) => expect(isReservedSlug(name)).toBe(true)
  );

  test('matching ignores case and surrounding whitespace', () => {
    expect(isReservedSlug(' Team ')).toBe(true);
    expect(isReservedSlug('ADMIN')).toBe(true);
  });

  test('ordinary business names are allowed', () => {
    expect(isReservedSlug('acme-cleaning')).toBe(false);
    expect(isReservedSlug('teams-clean')).toBe(false);
    expect(() => assertSubdomainAllowed('acme-cleaning')).not.toThrow();
  });

  test('the list has no duplicates and is all lowercase slugs', () => {
    expect(new Set(RESERVED_SLUGS).size).toBe(RESERVED_SLUGS.length);
    for (const s of RESERVED_SLUGS) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test('a reserved name is a 422 with a clear message', () => {
    expect.assertions(2);
    try {
      assertSubdomainAllowed('team');
    } catch (e) {
      expect(e.status).toBe(422);
      expect(e.message).toMatch(/reserved/i);
    }
  });

  test('a subdomain over the 63-character DNS label limit is rejected', () => {
    expect(() => assertSubdomainAllowed('a'.repeat(63))).not.toThrow();
    expect(() => assertSubdomainAllowed('a'.repeat(64))).toThrow(/at most 63/);
  });
});

describe('enforced where subdomains are created', () => {
  test('registerBusiness rejects a reserved subdomain before touching the database', async () => {
    await expect(
      registerBusiness({
        businessName: 'Team Co',
        subdomain: 'team',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.test',
        password: 'password123',
      })
    ).rejects.toMatchObject({ status: 422 });
  });

  test('createLocation rejects a reserved subdomain before touching the database', async () => {
    await expect(
      createLocation('biz1', 'user1', { name: 'HQ', subdomain: 'admin', timezone: 'Europe/Amsterdam' })
    ).rejects.toMatchObject({ status: 422 });
  });
});
