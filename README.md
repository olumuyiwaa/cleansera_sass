# CleanSera API

Multi-tenant cleaning business SaaS backend. See
`cleansera-architecture-plan.md` (shared separately) for the full design
rationale — this README covers what's actually in this scaffold.

## Status

The repository has moved past initial scaffolding; many modules are implemented and usable. Key implemented modules include:

- `auth` — business registration, login, refresh-token rotation, logout
- `cleaners` — onboarding, offboarding, availability, listing, clock-in/out
- `widget` — public booking engine: storefront, quote (with optional scheduledStart availability check), booking submission, and time-slot availability endpoint
- `businesses` — branding, addresses, service areas, and business hours management
- `services` — service catalog, add-ons, and pricing engine
- `bookings` — booking creation, quoted pricing, and basic assignment flows
- `dispatch` — suggestion API and basic auto-assign
- `checklists` — templates and per-booking checklist models
- `notifications` — queued delivery via Bull with socket.io emits
- `subscriptions` — Stripe integration for customer/subscription creation and webhook-based status updates

## Current implementation status (updated)

The codebase has progressed beyond initial scaffolding. Recent work implemented or significantly improved the following modules:

- `businesses`: branding, addresses, service areas, and business hours endpoints are available.
- `services`: full CRUD with add-ons and pricing models (FLAT, PER_SQFT, PER_ROOM, HOURLY) and pricing engine.
- `bookings`: create, assign, confirm, complete, recurring schedules, and pricing-quoted bookings.
- `dispatch`: dispatch dashboard, assignment creation and suggestion API with basic auto-assign.
- `checklists`: checklist templates and per-booking checklists; job photo model exists.
- `cleaners`: onboarding, offboarding, availability, clock-in/out with geo checks.
- `notifications`: queued delivery via Bull with retries, socket.io emits, failed-job monitoring endpoint.
- `subscriptions`: Prisma models and Stripe integration (customer/subscription creation + webhook status updates); plan enforcement on cleaner onboarding.
- `widget`: storefront, quote (pricing), booking submission, and a time-slot availability endpoint.

Remaining work items include richer pricing rules (business-configurable frequency discounts, coupons), advanced dispatch/routing (ETA via Distance Matrix), end-to-end recurring logic, customer portal features, and comprehensive reporting endpoints.

## Stripe Connect (job-level payments)

Two separate Stripe integrations exist and should not be confused:

1. **Platform subscription billing** (`subscriptions` module) — CleanSera charges each business for their CleanSera plan (Starter/Growth/Pro). Unaffected by anything below.
2. **Job-level payments** (`businesses` Connect endpoints + `bookings.createPaymentLink`) — a business's *own customers* paying for a cleaning job. As of this change, these funds are routed directly to the business via a Stripe Connect **destination charge**: CleanSera's platform account never holds the money, it only optionally collects `PLATFORM_APPLICATION_FEE_BPS` as an application fee on top.

Flow:

- `GET /businesses/stripe-connect/status` — returns `{ connected, onboarded, chargesEnabled, payoutsEnabled, readyForPayments }` for the current business.
- `POST /businesses/stripe-connect/onboard` — creates (or reuses) a Stripe Express connected account for the business and returns a hosted onboarding URL to redirect the business owner to.
- `POST /businesses/stripe-connect/refresh` — re-pulls account status from Stripe; use this on the `return_url` landing page in case the `account.updated` webhook hasn't arrived yet.
- `bookings.createPaymentLink` now **refuses** (`402`) to create a checkout session until `stripeChargesEnabled` is true for the business — a business can't accidentally take job payments into an unverified/unconnected account.

**Required Stripe Dashboard setup**: in addition to the existing webhook events, subscribe the webhook endpoint to `account.updated` (this is how the platform learns a connected account finished onboarding and can accept charges).

**Required migration**: `prisma/schema.prisma` gained `stripeConnectedAccountId`, `stripeConnectOnboarded`, `stripeChargesEnabled`, `stripePayoutsEnabled` on `Business`. Run:

```bash
npx prisma migrate dev --name add_stripe_connect_fields
```

**Not yet done** (next step, not included in this pass): a dashboard UI card in Business Settings that calls these three endpoints and shows connect status — see the frontend repo's gap notes.

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

1. Harden pricing and billing: business-configurable frequency discounts, coupons, and Stripe customer portal/proration flows.
2. Improve dispatch: integrate travel-time (Distance Matrix) for ETA-based ranking and workload balancing.
3. Strengthen recurring engine: idempotency, cancellations, and retry semantics.
4. Customer portal: reschedule, cancel, history, and reviews.
5. Reporting & analytics: revenue, utilization, and no-show metrics.
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

## Deployment (quick start)

This section describes minimal environment variables and examples for running scheduled workers that precompute widget slots.

- Environment variables (required for the API and workers):
  - `DATABASE_URL` — Postgres connection string used by Prisma.
  - `REDIS_URL` — Redis connection used for queues and slot caching (optional but recommended).
  - `JWT_SECRET` — secret for signing access tokens.
  - `GOOGLE_DISTANCE_MATRIX_API_KEY` — optional; used to compute ETA/distance for dispatch ranking.

- Database migration (run once after pulling schema changes):
```bash
npx prisma generate
npx prisma migrate dev --name init
```

- Run slot precompute worker manually (one-off):
```bash
npm run precompute-slots
```

- Kubernetes CronJob (example)
  - See `deploy/k8s/slot-precompute-cronjob.yaml` and `deploy/k8s/slot-precompute-secret-sa.yaml` for an example Secret, ServiceAccount and RBAC.
  - Apply via:
```bash
kubectl apply -f deploy/k8s/slot-precompute-secret-sa.yaml
kubectl apply -f deploy/k8s/slot-precompute-cronjob.yaml
```
  - Replace the image `your-registry/cleansera-api:latest` in the CronJob with your built image and ensure the `cleansera-secrets` secret contains `DATABASE_URL` and `REDIS_URL`.

- systemd (on-prem) example
  - Example unit and timer are in `deploy/systemd/slot-precompute.service` and `deploy/systemd/slot-precompute.timer`.
  - Example environment file: `deploy/systemd/cleansera.env.example` — copy to `/etc/default/cleansera` and edit values.
  - Install and enable the timer:
```bash
sudo cp deploy/systemd/slot-precompute.service /etc/systemd/system/
sudo cp deploy/systemd/slot-precompute.timer /etc/systemd/system/
sudo cp deploy/systemd/cleansera.env.example /etc/default/cleansera
sudo systemctl daemon-reload
sudo systemctl enable --now slot-precompute.timer
```

Notes
- The CronJob and systemd examples are minimal; adapt resource requests, security context, imagePullSecrets, and Namespace to your environment.
- In Kubernetes, prefer creating Secrets with `kubectl create secret generic cleansera-secrets --from-literal=DATABASE_URL='...' --from-literal=REDIS_URL='...'` rather than embedding secrets in YAML.


