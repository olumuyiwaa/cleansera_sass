# CleanSera API

Multi-tenant cleaning business SaaS backend.

CleanSera lets cleaning companies run their operations online: branded booking, customer management, cleaner management (owned by each business), scheduling, dispatch, checklists, payments, and reporting.

## Tech Stack

- **Runtime**: Node.js + Express
- **Database**: PostgreSQL + Prisma
- **Queue / Cache**: Redis + Bull
- **Auth**: JWT (access + refresh) + optional 2FA
- **Payments**:
  - Platform subscription billing → Stripe
  - Job-level customer payments → Stripe Connect (money goes to the business’s connected account)
- **Notifications**: SendGrid (email), Twilio (SMS), Firebase (push)
- **Storage**: S3-compatible (DigitalOcean Spaces)
- **Maps**: Google Maps + Distance Matrix
- **Realtime**: Socket.io

## Key Concepts

- **Business** = Tenant (subdomain / custom domain)
- Cleaners are **owned and managed by the business** (onboard / offboard)
- Customers are business-scoped
- Platform never holds customer job money (Stripe Connect)
- Platform subscription billing is completely separate from job payments

## Getting Started

### 1. Prerequisites

- Node.js 18+
- PostgreSQL
- Redis
- Stripe account (test mode is fine)
- (Optional) Twilio, SendGrid, Firebase, Google Maps keys

### 2. Clone & Install

```bash
git clone https://github.com/olumuyiwaa/cleansera_sass.git
cd cleansera_sass
npm install
```

### 3. Environment

```bash
cp .env.example .env
```

Fill in the required values (see comments in `.env.example`).

### 4. Database

```bash
npx prisma generate
npx prisma migrate dev
npm run seed          # optional demo data
```

### 5. Run

```bash
# API
npm run dev

# Background workers (separate terminals)
npm run notification-worker
npm run recurring-daemon
npm run reminder-daemon
```

API will be available at `http://localhost:8000`.

## Main Modules

| Module              | Purpose                                      |
|---------------------|----------------------------------------------|
| `auth`              | Registration, login, refresh, 2FA            |
| `businesses`        | Tenant settings, branding, hours, service areas |
| `cleaners`          | Onboard / offboard, availability, documents  |
| `customers`         | CRM + addresses                              |
| `services`          | Catalog + add-ons + pricing models           |
| `bookings`          | One-off + recurring, cancel, reschedule      |
| `dispatch`          | Assignment + suggestions                     |
| `widget`            | Public booking engine (host-based resolution)|
| `customerPortal`    | Customer self-service (OTP login)            |
| `subscriptions`     | Platform billing (CleanSera → Business)      |
| `reports`           | KPIs, revenue, cleaner performance           |
| `checklists`        | Job checklists + templates                   |
| `notifications`     | Email / SMS / Push                           |
| `reviews`           | Customer reviews                             |
| `messaging`         | In-app messaging                             |

## Scripts

```bash
npm run dev                 # API (nodemon)
npm run start               # Production
npm run notification-worker
npm run recurring-daemon
npm run reminder-daemon
npm run seed
npm run studio              # Prisma Studio
npm test
```

## Multi-tenancy

Business resolution is done via the `Host` header (subdomain or custom domain).  
The public widget and customer portal both use this pattern.

## Stripe Model

- **Platform Subscription**: CleanSera charges the cleaning business monthly.
- **Job Payments**: Customer pays → money goes to the business’s Stripe Connect account (platform takes a configurable application fee in basis points).

## License

Private / UNLICENSED
