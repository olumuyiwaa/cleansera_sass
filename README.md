# CleanSera API (Backend)

Multi-tenant cleaning business SaaS backend for **CleanSera**.

Cleaning businesses own their customers, roster, branding, and booking flow. Cleaners are onboarded and offboarded by the business that employs them — not by a marketplace. The platform takes a flat subscription, never a cut of job payments.

This repository is the Express + Prisma API that powers:

- Business dashboard (`cleansera_sass_frontend`)
- Public booking widgets & customer portals
- Cleaner mobile app (`cleansera_cleaner_app`)
- Marketing site forms (`cleansera_sass_website`)

---

## Table of contents

- [Architecture overview](#architecture-overview)
- [Tech stack](#tech-stack)
- [Repository structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Workers & background jobs](#workers--background-jobs)
- [Key domain concepts](#key-domain-concepts)
- [API surface](#api-surface)
- [Auth & multi-tenancy](#auth--multi-tenancy)
- [Payments](#payments)
- [Testing](#testing)
- [Scripts](#scripts)
- [Related repositories](#related-repositories)

---

## Architecture overview

```
┌─────────────────────┐     ┌──────────────────────┐
│  Business Dashboard │     │  Cleaner Mobile App  │
│  (Next.js frontend) │     │  (Flutter)           │
└──────────┬──────────┘     └──────────┬───────────┘
           │                           │
           │         HTTPS / WSS       │
           ▼                           ▼
┌──────────────────────────────────────────────────┐
│              CleanSera API (this repo)           │
│  Express · Prisma · Socket.io · Bull workers     │
└───────┬───────────────────────┬──────────────────┘
        │                       │
        ▼                       ▼
   PostgreSQL              Redis (queues)
        │
        └── Stripe · Twilio · SendGrid · S3 · Firebase · Google Maps
```

- **Multi-tenant**: every business resource is scoped by `businessId`. Subdomain / custom domain resolution selects the tenant for public booking.
- **Cleaners belong to businesses**: `CleanerProfile` is unique on `(businessId, userId)`. A person can work for multiple businesses with separate profiles.
- **Money split**:
  - Platform subscription billing (CleanSera → Business) via Stripe Subscriptions.
  - Job payments (Customer → Business) via Stripe Connect. Platform application fee defaults to **0** (no take-rate on bookings).
  - Cleaner payouts via Stripe Connect on the cleaner’s user account (or manual).

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js |
| Framework | Express |
| ORM | Prisma 5 |
| Database | PostgreSQL |
| Queue / jobs | Bull + Redis |
| Realtime | Socket.io |
| Auth | JWT (access + refresh), optional 2FA (Speakeasy) |
| Payments | Stripe (Subscriptions + Connect) |
| Email | SendGrid |
| SMS / OTP | Twilio |
| Push | Firebase Admin |
| Storage | S3-compatible (DigitalOcean Spaces) |
| Maps | Google Maps / Distance Matrix |
| Validation | Zod + express-validator |
| Logging | Winston |
| Docs | Swagger (swagger-jsdoc + swagger-ui-express) |

---

## Repository structure

```
cleansera_sass/
├── prisma/
│   ├── schema.prisma      # Full data model
│   ├── migrations/
│   └── seed.js
├── src/
│   ├── app.js             # Express app setup
│   ├── server.js          # HTTP + Socket.io entry
│   ├── config/            # Env, Stripe, Redis, etc.
│   ├── lib/               # Shared helpers (pricing, slots, …)
│   ├── middleware/        # Auth, tenant scope, rate limit, …
│   ├── modules/           # Domain modules (auth, bookings, cleaners, …)
│   ├── routes/            # Route mounting
│   ├── utils/
│   └── workers/           # Background job processors & daemons
├── scripts/
├── test/
├── deploy/
├── .env.example
└── package.json
```

Modules follow a consistent pattern: `*.routes.js` → `*.controller.js` → `*.service.js`.

---

## Prerequisites

- Node.js 18+ (20 recommended)
- PostgreSQL 14+
- Redis 6+
- Stripe account (test keys for local)
- Optional for full features: Twilio, SendGrid, Firebase project, DigitalOcean Spaces (or any S3-compatible bucket), Google Maps API key

---

## Local setup

```bash
# 1. Clone
git clone https://github.com/olumuyiwaa/cleansera_sass.git
cd cleansera_sass

# 2. Install
npm install

# 3. Environment
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL, REDIS_URL, JWT secrets, and Stripe keys

# 4. Database
npx prisma generate
npx prisma migrate dev
npm run seed          # optional demo data

# 5. Start API
npm run dev           # nodemon on PORT (default 8000)
```

In separate terminals (or as system services in production):

```bash
npm run notification-worker
npm run recurring-daemon    # or recurring-worker
npm run reminder-daemon
# optional: npm run precompute-slots
```

API base URL (local): `http://localhost:8000/api/v1`

---

## Environment variables

See `.env.example` for the full list and comments. Critical groups:

| Group | Purpose |
|-------|---------|
| `DATABASE_URL` | PostgreSQL connection |
| `REDIS_URL` | Bull queues + caching |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Auth tokens |
| `FRONTEND_URL` / `APP_URL` | CORS, redirects, deep links |
| `WIDGET_BASE_DOMAIN` | Host-based tenant resolution for public widgets |
| `STRIPE_*` | Platform subscription billing |
| `PLATFORM_APPLICATION_FEE_BPS` | **Keep at 0** unless product positioning changes |
| `TWILIO_*` | SMS / OTP |
| `SENDGRID_*` / `EMAIL_FROM` | Transactional email |
| `FIREBASE_*` | Cleaner app push notifications |
| `DO_SPACES_*` | File storage (job photos, documents, branding) |
| `GOOGLE_MAPS_API_KEY` | Geocoding, service areas, distance |
| `DEFAULT_CURRENCY` | ISO 4217 (e.g. `usd`) |

Never commit real secrets. Use `.env` locally and a secrets manager in production.

---

## Database

Prisma schema lives in `prisma/schema.prisma`.

Main domains:

- **Auth & users** — `User`, sessions, OTP, password reset, global roles
- **Business (tenant)** — branding, addresses, service areas, hours, pricing policies, coupons, gift cards, waitlist, subscription
- **Cleaners** — `CleanerProfile` (per-business), availability, documents, compensation, earnings, payouts, device tokens
- **Customers & bookings** — one-off and recurring, assignments, checklists, reviews
- **Operations** — inventory, compliance, messaging, notifications, support tickets, audit logs

Useful commands:

```bash
npx prisma migrate dev          # create + apply migration
npx prisma migrate deploy       # production
npx prisma studio               # GUI
npm run seed
```

---

## Workers & background jobs

| Script | Role |
|--------|------|
| `notification-worker` | Processes notification queue (email, SMS, push) |
| `recurring-worker` / `recurring-daemon` | Generates future instances from recurring schedules |
| `reminder-daemon` / `send-reminders` | Appointment reminders |
| `precompute-slots` | Availability slot precomputation |

Run workers alongside the API in development. In production, run them as separate processes or containers.

---

## Key domain concepts

### Business-owned cleaners

- Businesses invite / onboard cleaners.
- Status flow: `PENDING` → `ACTIVE` → `SUSPENDED` / `OFFBOARDED`.
- Offboarding sets `offboardedAt` / reason and stops future assignments while preserving history.
- Stripe Connect for payouts is on the **User**, so a cleaner who works for two businesses only completes Connect once.

### Bookings & recurring

- One-time and recurring schedules.
- Assignments link cleaners to jobs (team jobs supported).
- Pricing engine supports frequency discounts, deposits, cancellation fees, per-sqft / per-room rates, coupons, and gift cards.

### Payroll

- Per-cleaner compensation: percent of job, flat per job, or hourly.
- Earnings are snapshotted at job completion.
- Payouts batch pending earnings (manual or Stripe transfer to cleaner).

### Public booking

- Resolved by subdomain (`WIDGET_BASE_DOMAIN`) or custom domain.
- Branding, services, availability, and policies are tenant-scoped.

---

## API surface

Routes are versioned under `/api/v1`.

Typical module areas (see `src/modules/` and `src/routes/`):

- Auth & onboarding
- Businesses, team, locations (franchise)
- Cleaners, documents, compensation
- Customers, bookings, recurring schedules
- Dispatch, calendar
- Services, pricing, coupons, gift cards, waitlist
- Payroll & payouts
- Inventory, compliance
- Messaging, notifications
- Reviews, reports
- Subscription (platform billing)
- Public widget / portal endpoints
- Admin (platform)

Swagger UI is available when the server is running (path configured in the app).

---

## Auth & multi-tenancy

- Access + refresh JWT.
- Optional 2FA.
- Session can be bound to a `businessId` so multi-business users (e.g. cleaners) stay in the correct workspace on refresh.
- Middleware enforces tenant scope and role checks (`BUSINESS_OWNER`, `BUSINESS_MANAGER`, `ORG_ADMIN`, cleaner, customer).

---

## Payments

1. **Platform subscription** — Business pays CleanSera (Starter / Growth / Pro). Handled with Stripe Customer + Subscription. Webhook required.
2. **Job payments** — Customer pays the business via Stripe Connect. Platform fee BPS defaults to 0.
3. **Cleaner payouts** — Business marks earnings paid manually or triggers Stripe transfer to the cleaner’s connected account.

Configure Stripe webhooks to your public API URL for subscription and Connect events.

---

## Testing

```bash
npm run test:unit    # Jest
npm run test:queue   # Queue smoke test
npm test             # both
```

Add integration tests around multi-tenant isolation, booking conflicts, recurring generation, and payout correctness as the product stabilizes.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | API with nodemon |
| `npm start` | Production API |
| `npm run generate` | `prisma generate` |
| `npm run migrate:dev` | Dev migrations |
| `npm run migrate` | Deploy migrations |
| `npm run seed` | Seed database |
| `npm run studio` | Prisma Studio |
| `npm run notification-worker` | Notification queue worker |
| `npm run recurring-daemon` | Recurring job generator |
| `npm run reminder-daemon` | Reminder daemon |

---

## Related repositories

| Repo | Role |
|------|------|
| [cleansera_sass_frontend](https://github.com/olumuyiwaa/cleansera_sass_frontend) | Business dashboard, public sites, customer portal |
| [cleansera_cleaner_app](https://github.com/olumuyiwaa/cleansera_cleaner_app) | Flutter app for cleaners |
| [cleansera_sass_website](https://github.com/olumuyiwaa/cleansera_sass_website) | Marketing site |

---

## License

UNLICENSED — private. All rights reserved.
