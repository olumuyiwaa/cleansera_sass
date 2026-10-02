/**
 * Subdomains a business must never be able to claim.
 *
 * A storefront lives at <subdomain>.<root domain>. Names that collide with our
 * own hostnames (www, api, admin ...) or with a route the app itself serves
 * (team, bookings, calendar ...) would give that business a dead or hijacked
 * site: the frontend rewrites a tenant host "team.cleansera.nl" to "/team",
 * which is the dashboard's own page, so the frontend refuses to serve it.
 *
 * KEEP IN SYNC with the frontend's src/lib/reservedSlugs.ts. The frontend runs
 * `npm run check:slugs` in CI so a new route folder fails the build until it is
 * listed there; copy any addition here as well.
 */
const RESERVED_SLUGS = Object.freeze([
  // Infrastructure / conventional hostnames
  'www', 'app', 'api', 'admin', 'auth', 'static', 'assets', 'cdn', 'mail',
  'smtp', 'ftp', 'ns1', 'ns2', 'staging', 'dev', 'test', 'status', 'docs',
  'blog', 'help', 'widget', 'embed', 'login', 'signin', 'signup',

  // Marketing + legal
  'about', 'for-businesses', 'for-cleaners', 'how-it-works', 'pricing',
  'pricing-page', 'privacy', 'terms', 'support',

  // Public app routes
  'book-now', 'portal', 'site', 'services', 'error-404',
  'forgot-password', 'reset-password', 'verify-email',

  // Dashboard routes
  'dashboard', 'audit-trail', 'bookings', 'business-settings', 'calendar',
  'checklist-templates', 'cleaner-documents', 'cleaners', 'compliance',
  'coupons', 'customers', 'dispatch', 'gift-cards', 'inventory', 'messages',
  'notifications', 'onboarding', 'payroll', 'profile', 'recurring-schedules',
  'reports', 'reviews', 'subscription', 'support-tickets', 'team', 'waitlist',
  'website',
]);

const RESERVED_SET = new Set(RESERVED_SLUGS);

// A DNS label is at most 63 characters; a longer subdomain can never resolve.
const MAX_SUBDOMAIN_LENGTH = 63;

function isReservedSlug(slug) {
  return RESERVED_SET.has(String(slug ?? '').trim().toLowerCase());
}

/** Throws a 422 for a subdomain that must not be registered. */
function assertSubdomainAllowed(subdomain) {
  if (isReservedSlug(subdomain)) {
    const err = new Error('That subdomain is reserved. Please choose another');
    err.status = 422;
    throw err;
  }
  if (String(subdomain ?? '').length > MAX_SUBDOMAIN_LENGTH) {
    const err = new Error(`Subdomain must be at most ${MAX_SUBDOMAIN_LENGTH} characters`);
    err.status = 422;
    throw err;
  }
}

module.exports = { RESERVED_SLUGS, isReservedSlug, assertSubdomainAllowed, MAX_SUBDOMAIN_LENGTH };
