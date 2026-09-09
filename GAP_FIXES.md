# CleanSera Gap Fixes (Phase 1 — Backend)

Applied against the `cleansera_sass` backend. These close the highest-impact operational gaps so the product can compete on day-to-day cleaning ops.

## What was added / fixed

### Bookings
- **Cancel** — `POST /bookings/:id/cancel` `{ reason? }`
- **Reschedule** — `POST /bookings/:id/reschedule` `{ scheduledStart, scheduledEnd? }` (checks assigned cleaner free at new time)
- **Payment bookkeeping** — `POST /bookings/:id/payment` `{ paymentStatus: UNPAID|PAID|PARTIAL|REFUNDED, paymentNote? }`
- **Complete → review request** — completing a booking now emails/SMS the customer asking for a review
- **Route order** — `/recurring` registered before `/:id` so it is not swallowed by the param route

### Customers (CRM)
- Search (`?q=`)
- Include addresses + booking count on list
- Full customer detail (addresses, recent bookings, active recurring, reviews)
- **Addresses CRUD**
  - `POST /customers/:id/addresses`
  - `PUT /customers/:id/addresses/:addressId`
  - `DELETE /customers/:id/addresses/:addressId`
- Safe delete (blocked if upcoming bookings exist)
- Optional address on customer create

### Reports
- `GET /reports` — summary
- `GET /reports/kpis?from=&to=` — completion/cancel rates, revenue, collected, avg ticket, utilization, no-shows, cleaner counts
- `GET /reports/revenue?from=&to=` — revenue by day
- `GET /reports/cleaner-performance?from=&to=` — per-cleaner jobs / revenue / check-ins

### Notifications
- `notifyBookingCancelled`
- `notifyBookingRescheduled`
- `requestReview` (used on complete)

### Customer portal (public, host-scoped)
New mount: `/portal` (same Host → business resolution as `/widget`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/portal/access/request` | none | Send OTP to phone/email |
| POST | `/portal/access/verify` | none | Exchange OTP for 7-day portal JWT |
| GET | `/portal/bookings` | portal JWT | List my bookings |
| GET | `/portal/bookings/:id` | portal JWT | Booking detail |
| POST | `/portal/bookings/:id/cancel` | portal JWT | Cancel (≥12h before start) |
| POST | `/portal/bookings/:id/reschedule` | portal JWT | Reschedule with availability check |
| POST | `/portal/bookings/:id/review` | portal JWT | Leave 1–5 star review |

## Still remaining (next phases)

1. **Frontend** — wire dashboard screens to cancel/reschedule/payment/reports/addresses; build simple customer portal UI
2. **Job-level payments** — Stripe Payment Links / invoice links (platform still does not take job money)
3. **Travel-time dispatch** — fully enable Distance Matrix ranking + workload balancing
4. **Rich booking widget UI** — multi-step form + pricing calculator (API already supports quote/slots/book)
5. **Cleaner mobile app / PWA**
6. **Marketing site** — wire demo-request forms
7. **Cleaner multi-business** — composite unique `(businessId, userId)` when you want to unlock that

## How to apply

If you are pulling from this working tree:

```bash
cd cleansera_backend
# review diff
git status
git diff
# then commit / open PR against your main
```

Or copy the changed files into your repo:

- `src/modules/bookings/*`
- `src/modules/customers/*`
- `src/modules/reports/*`
- `src/modules/notifications/notifications.service.js`
- `src/modules/customerPortal/**` (new)
- `src/routes/index.js`
