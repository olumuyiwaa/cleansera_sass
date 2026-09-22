# CleanSera API

Multi-tenant backend for **CleanSera** — scheduling, dispatch, payroll, and
a public booking widget for cleaning businesses. Each business owns its
customers, roster, and branding; cleaners are onboarded and offboarded by
the business that employs them, not by a marketplace.

Frontend: [cleansera_sass_frontend](https://github.com/olumuyiwaa/cleansera_sass_frontend) · Marketing site: [cleansera_sass_website](https://github.com/olumuyiwaa/cleansera_sass_website) · Cleaner app: [cleansera_cleaner_app](https://github.com/olumuyiwaa/cleansera_cleaner_app)

---

## Table of contents

- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Modules](#modules)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Multi-tenancy](#multi-tenancy)
- [Custom domains](#custom-domains)
- [Payments & Dutch VAT](#payments--dutch-vat)
- [Background workers](#background-workers)
- [Deployment](#deployment)
- [Related repositories](#related-repositories)

---

## Architecture

Every business-scoped table carries a `businessId` foreign key
(`prisma/schema.prisma`). Three pieces enforce that a request can only ever
touch its own tenant's data:

- **`src/middleware/authenticate.js`** — resolves `req.user.businessId` /
  `businessRole` from the database on every request, never trusts the JWT
  body alone. A revoked `BusinessMember` or an offboarded `CleanerProfile`
  loses access immediately, not at next token refresh.
- **`src/middleware/scopeToBusiness.js`** — sets `req.businessId`, the
  single source of truth every service function filters by. Every
  authenticated dashboard route uses this; a `businessId` is never accepted
  from the client body.
- **`src/middleware/resolveBusinessFromHost.js`** / **`resolveBusinessFromSlug.js`**
  — resolve the tenant for the *public, unauthenticated* booking widget and
  customer portal, from the request's Host header or a `:subdomain` route
  param. This is what makes "no cross-business discovery" true at the
  widget level, not just the dashboard.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js, Express |
| Database | PostgreSQL via Prisma |
| Queues / cache | Redis, Bull |
| Auth | JWT (access + refresh rotation), speakeasy (2FA), qrcode |
| Payments | Stripe (Connect direct charges for job payments, platform subscription billing) |
| Storage | AWS S3-compatible client (DigitalOcean Spaces) |
| Realtime | Socket.io |
| Notifications | SendGrid, Nodemailer, Twilio, Firebase Admin (push) |
| Maps | Google Maps Services (distance/geocoding) |
| Validation | express-validator, Zod |
| Docs | swagger-jsdoc / swagger-ui-express at `/api-docs` |
| Logging | Winston (daily rotate) |
| Tests | Jest, Supertest |

## Modules

Each is a self-contained `routes` / `controller` / `service` folder under
`src/modules/`, mounted in `src/routes/index.js`:

| Mount | Module | Covers |
|---|---|---|
| `/auth` | auth | Registration, login, refresh rotation, 2FA, logout |
| `/businesses` | businesses | Branding, addresses, service areas, hours, Stripe Connect status, franchise locations |
| `/businesses/pricing` | pricing | Frequency discounts, deposit & cancellation policy |
| `/businesses/staff` | staff | Team invites, roles, removal |
| `/businesses/me/custom-domain` · `/public/resolve-domain` | domains | Custom-domain setup, DNS ownership verification, public resolver for the frontend and TLS issuance |
| `/subscriptions` | subscriptions | CleanSera's own platform billing (Stripe Billing) |
| `/cleaners`, `/cleaners/me/*` | cleaners, cleanerSelf | Onboarding, offboarding, availability, clock-in/out, self-service profile |
| `/customers` | customers | Business-scoped CRM, GDPR-style anonymize-on-request |
| `/services` | services | Catalog, add-ons, pricing models (flat / per-size / per-room / hourly) |
| `/bookings`, `/cleaner/bookings` | bookings | Creation, assignment, confirm/complete, recurring schedules, admin vs. cleaner-scoped views |
| `/dispatch` | dispatch | Assignment suggestions, basic auto-assign |
| `/checklists`, `/checklist-templates` | checklists | Per-booking checklists and reusable templates |
| `/messaging` | messaging | Business ↔ cleaner ↔ customer conversations |
| `/notifications` | notifications | Queued email/SMS/push delivery via Bull |
| `/reviews` | reviews | Customer reviews |
| `/reports` | reports | Analytics |
| `/storage` | storage | Signed upload URLs |
| `/support-tickets`, `/support` | supportTickets, supportContact | Internal ticketing and public contact form |
| `/cleaner-documents` | cleanerDocuments | ID, background check, certification, contract, insurance uploads |
| `/widget`, `/widget-embed/:subdomain` | widget | Public booking engine — storefront, quote, availability, submission |
| `/portal`, `/portal-embed/:subdomain` | customerPortal | Customer self-service: bookings, reschedule, cancel, review, tip |
| `/calendar` | calendar | Calendar views |
| `/inventory` | inventory | Stock & locations |
| `/compliance` | compliance | Documents, training acknowledgements, audits |
| `/payroll` | payroll | Compensation rules, earnings, payout batches, cleaner Stripe Connect payouts |
| `/waitlist` | waitlist | Demand capture when fully booked |
| `/invoices` | invoices | Customer-facing, BTW-compliant, gapless-numbered invoices |
| `/demo-requests` | demoRequests | Leads from the marketing site |
| `/super-admin` | superAdmin | Platform-wide oversight, not tenant-scoped |

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL at minimum
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

Seed checklist templates and an example business:
```bash
npm run seed
```

API docs are served at `/api-docs` once running.

## Environment variables

See `.env.example` for the full list. The ones worth knowing about going in:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Queues and slot caching (recommended, not strictly required) |
| `JWT_SECRET` | Access token signing |
| `WIDGET_BASE_DOMAIN` | Shared root domain for `<subdomain>.WIDGET_BASE_DOMAIN` storefronts |
| `CUSTOM_DOMAIN_CNAME_TARGET` | What businesses point their own domain's CNAME at |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRETS` | Platform billing + connected-account job payments |
| `GOOGLE_DISTANCE_MATRIX_API_KEY` | ETA-based dispatch ranking (optional) |
| `DEFAULT_CURRENCY` | Defaults to `eur` |

## Multi-tenancy

Path- and host-based resolution both exist, for different callers:

- **Dashboard, admin, auth** — authenticated, resolved from the JWT via
  `scopeToBusiness`. Not reachable by Host header at all.
- **Public widget & portal** — resolved either from the Host header
  (`resolveBusinessFromHost`, for a business's own subdomain or verified
  custom domain) or from a `:subdomain` route param
  (`resolveBusinessFromSlug`, for embedding from a single shared widget
  domain with zero DNS setup). Both paths land on the same `req.businessId`;
  neither ever accepts a business ID from the client directly.

## Custom domains

A business can set a `customDomain` on their account, but it only routes
traffic once ownership is proven: setting it generates a verification
token, the business adds a TXT record at
`_cleansera-challenge.<domain>`, and `POST /businesses/me/custom-domain/verify`
(or the background `domain-verification-worker`, polling every 5 minutes)
confirms it before `customDomainStatus` flips to `VERIFIED`.
`resolveBusinessFromHost` and the public `/public/resolve-domain` endpoint
both refuse to route or resolve an unverified domain — the same endpoint
doubles as the `ask` hook for Caddy's `on_demand_tls`, so a certificate is
never issued for a domain no business has proven they control (see
`deploy/caddy/Caddyfile`).

## Payments & Dutch VAT

Prices are stored VAT-inclusive, per the Dutch requirement for
consumer-facing prices. `Business.vatRateBps` defaults to 2100 (21%);
`Service.vatRateBps` can override per service (e.g. 900 for the 9% rate
that applies to cleaning inside a home). Invoices use a gapless,
per-business sequential counter and are never edited once issued — both
required for Dutch fiscal compliance.

Job payments are **direct charges on the business's own Stripe Connect
account** — money never sits in CleanSera's balance. Platform subscription
billing (what a business pays CleanSera) is separate Stripe Billing,
unrelated to job payments. Checkout uses Stripe's dynamic payment methods,
so iDEAL appears automatically for EUR once the connected account enables
it. Recurring jobs can save a payment method (`setup_future_usage`) and
charge it off-session on the next visit via `stripeClient.chargeSavedPaymentMethod`,
falling back to an emailed payment link if a card requires
Strong Customer Authentication.

## Background workers

| Command | Does |
|---|---|
| `npm run notification-worker` | Processes queued email/SMS jobs (needs Redis, `NOTIFICATION_QUEUE=true`) |
| `npm run recurring-daemon` | Creates scheduled recurring bookings; exposes `/status` on `RECURRING_DAEMON_PORT` |
| `npm run domain-verification-worker` | Re-checks pending custom domains until their TXT record verifies |
| `npm run precompute-slots` | Precomputes widget availability slots (see `deploy/k8s` for a CronJob example) |
| `npm run send-reminders` / `reminder-daemon` | Booking reminders |

## Deployment

No app platform assumed — `deploy/` has examples for Kubernetes (CronJob
for slot precompute), systemd (on-prem timers), and Caddy (automated TLS
for tenant custom domains via `on_demand_tls`, gated by domain
verification). Run migrations with `npm run migrate` (`prisma migrate
deploy`), not `migrate dev`, in production.

## Related repositories

| Repo | Role |
|---|---|
| [cleansera_sass_frontend](https://github.com/olumuyiwaa/cleansera_sass_frontend) | Business dashboard, storefront, customer portal |
| [cleansera_cleaner_app](https://github.com/olumuyiwaa/cleansera_cleaner_app) | Cleaner mobile app (Flutter) |
| [cleansera_sass_website](https://github.com/olumuyiwaa/cleansera_sass_website) | Marketing site |

## License

Private — all rights reserved.
