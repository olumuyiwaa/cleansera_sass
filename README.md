# CleanSera API

Multi-tenant cleaning business SaaS backend. See
`cleansera-architecture-plan.md` (shared separately) for the full design
rationale — this README covers what's actually in this scaffold.

## Status

**Fully implemented** (reference pattern to copy for the rest):
- `auth` — business registration (creates tenant + owner in one transaction), login, refresh-token rotation, logout
- `cleaners` — onboarding, offboarding, availability, listing
- `widget` — public booking engine: storefront, quote, booking submission, all resolved from the request's Host header via `resolveBusinessFromHost`

**Scaffolded only** (route file exists, returns an empty stub — build these next, following the `cleaners` module's shape of `*.service.js` / `*.controller.js` / `*.routes.js`):
`businesses`, `subscriptions`, `customers`, `services`, `bookings`, `dispatch`, `checklists`, `messaging`, `notifications`, `reviews`, `reports`, `storage`

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL at minimum to get started
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

## Key architectural pieces to understand before extending

- **`src/middleware/authenticate.js`** — resolves `req.user.businessId` /
  `businessRole` from the DB on every request (not trusted from the JWT body),
  so a revoked `BusinessMember` or offboarded `CleanerProfile` loses access
  immediately.
- **`src/middleware/scopeToBusiness.js`** — sets `req.businessId`, the single
  source of truth every service function should filter by. Every dashboard
  route should use this — never take a `businessId` from the client body on
  an authenticated route.
- **`src/middleware/resolveBusinessFromHost.js`** — the widget's tenant
  resolution, from subdomain or custom domain. This is what makes "no
  cross-business discovery" actually true at the API level.
- **`prisma/schema.prisma`** — every business-scoped model carries a
  `businessId` FK; `Customer` is intentionally scoped per business (not
  global), matching the white-label decision.

## Next steps

1. Build out the stubbed modules, starting with `businesses` (branding/domain
   management) and `services` (catalog) — `bookings` and `dispatch` depend on
   both existing first.
2. Wire `subscriptions` to Stripe Billing (CleanSera ↔ Business only — no
   job-level payment processing, per the architecture plan).
3. Add the Flutter cleaner app and Next.js business dashboard as separate
   repos consuming this API.

## Workers & background jobs

- Notification worker: `npm run notification-worker` — processes queued email/sms jobs (requires Redis and `NOTIFICATION_QUEUE=true`). Failed jobs alert `ADMIN_EMAIL` when attempts are exhausted.
- Recurring daemon: `npm run recurring-daemon` — runs scheduled recurring booking creation and exposes `/status` on port `4001` (see `RECURRING_DAEMON_PORT` and `RECURRING_CRON`).

## CI-friendly queue test

Run `npm test` in CI (requires Redis available at `REDIS_URL`) — this will execute a transient queue test that verifies Bull can enqueue and process a job.

## Seeding

Seed checklist templates with:

```bash
npm run seed
```

This creates an example business if none exists and adds sample `ChecklistTemplate` rows.

