const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const PASSWORD = 'Password123#'; // default password for all seeded users

async function hash(pw) {
  return bcrypt.hash(pw, 12);
}

async function seed() {
  console.log('Seeding CleanSera...\n');

  const passwordHash = await hash(PASSWORD);

  // ─────────────────────────────────────────────
  // 1. SUPER ADMIN
  // ─────────────────────────────────────────────
  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@cleansera.com' },
    update: {},
    create: {
      email: 'admin@cleansera.com',
      phone: '+2348000000001',
      passwordHash,
      firstName: 'Super',
      lastName: 'Admin',
      globalRole: 'SUPER_ADMIN',
      isEmailVerified: true,
    },
  });
  console.log('✓ Super admin:', superAdmin.email);

  // ─────────────────────────────────────────────
  // 2. BUSINESS OWNER
  // ─────────────────────────────────────────────
  const owner = await prisma.user.upsert({
    where: { email: 'owner@example.com' },
    update: {},
    create: {
      email: 'owner@example.com',
      phone: '+2348000000002',
      passwordHash,
      firstName: 'Ada',
      lastName: 'Okeke',
      globalRole: 'PLATFORM_USER',
      isEmailVerified: true,
    },
  });
  console.log('✓ Business owner:', owner.email);

  // ─────────────────────────────────────────────
  // 3. BUSINESS + branding + hours + address + areas + pricing
  // ─────────────────────────────────────────────
  let business = await prisma.business.findUnique({ where: { subdomain: 'example' } });
  if (!business) {
    business = await prisma.business.create({
      data: {
        name: 'SparkleClean Netherlands',
        subdomain: 'ladygreener',
        timezone: 'Europe/Netherlands',
        branding: {
          create: {
            primaryColor: '#0EA5E9',
            accentColor: '#F59E0B',
            tagline: 'Professional cleaning, done right',
            widgetEmbedEnabled: true,
          },
        },
        hours: {
          create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            dayOfWeek,
            openTime: '08:00',
            closeTime: '18:00',
            isClosed: dayOfWeek === 0,
          })),
        },
        addresses: {
          create: [
            {
              label: 'HQ',
              line1: '12 Admiralty Way',
              city: 'Lekki',
              state: 'Lagos',
              postalCode: '105102',
              country: 'NG',
              latitude: 6.4474,
              longitude: 3.4722,
              isPrimary: true,
            },
            {
              label: 'Warehouse',
              line1: '45 Industrial Avenue',
              city: 'Ikeja',
              state: 'Lagos',
              postalCode: '100001',
              country: 'NG',
              isPrimary: false,
            },
            {
              label: 'Training Centre',
              line1: '8 Allen Avenue',
              city: 'Ikeja',
              state: 'Lagos',
              postalCode: '100271',
              country: 'NG',
              isPrimary: false,
            },
          ],
        },
        serviceAreas: {
          create: [
            { name: 'Lekki Phase 1', centerLat: 6.4474, centerLng: 3.4722, radiusMeters: 5000 },
            { name: 'Victoria Island', centerLat: 6.4281, centerLng: 3.4219, radiusMeters: 4000 },
            { name: 'Ikeja GRA', centerLat: 6.6018, centerLng: 3.3515, radiusMeters: 6000 },
          ],
        },
        pricing: {
          create: {
            frequencyDiscounts: { WEEKLY: 0.1, BIWEEKLY: 0.05, MONTHLY: 0.0 },
          },
        },
      },
    });
    console.log('✓ Business:', business.name);
  } else {
    console.log('✓ Business already exists:', business.name);
  }

  // Owner membership
  await prisma.businessMember.upsert({
    where: { businessId_userId: { businessId: business.id, userId: owner.id } },
    update: {},
    create: {
      businessId: business.id,
      userId: owner.id,
      role: 'BUSINESS_OWNER',
      isActive: true,
      joinedAt: new Date(),
    },
  });

  // Manager user + membership
  const manager = await prisma.user.upsert({
    where: { email: 'manager@example.com' },
    update: {},
    create: {
      email: 'manager@example.com',
      phone: '+2348000000003',
      passwordHash,
      firstName: 'Chidi',
      lastName: 'Eze',
      globalRole: 'PLATFORM_USER',
      isEmailVerified: true,
    },
  });
  await prisma.businessMember.upsert({
    where: { businessId_userId: { businessId: business.id, userId: manager.id } },
    update: {},
    create: {
      businessId: business.id,
      userId: manager.id,
      role: 'BUSINESS_MANAGER',
      isActive: true,
      joinedAt: new Date(),
    },
  });
  console.log('✓ Business members (owner + manager)');

  // ─────────────────────────────────────────────
  // 4. SUBSCRIPTION PLANS + BUSINESS SUBSCRIPTION
  // ─────────────────────────────────────────────
  const plans = [
    { name: 'Starter', stripePriceId: 'price_starter_seed', maxCleaners: 3, monthlyPriceCents: 1500000, features: { sms: false, widget: true } },
    { name: 'Growth', stripePriceId: 'price_growth_seed', maxCleaners: 15, monthlyPriceCents: 3500000, features: { sms: true, widget: true } },
    { name: 'Pro', stripePriceId: 'price_pro_seed', maxCleaners: null, monthlyPriceCents: 7500000, features: { sms: true, widget: true, prioritySupport: true } },
  ];

  const createdPlans = [];
  for (const p of plans) {
    const plan = await prisma.subscriptionPlan.upsert({
      where: { name: p.name },
      update: {},
      create: p,
    });
    createdPlans.push(plan);
  }
  console.log('✓ Subscription plans:', createdPlans.map((p) => p.name).join(', '));

  let subscription = await prisma.businessSubscription.findUnique({ where: { businessId: business.id } });
  if (!subscription) {
    subscription = await prisma.businessSubscription.create({
      data: {
        businessId: business.id,
        planId: createdPlans[1].id, // Growth
        stripeCustomerId: 'cus_seed_example',
        stripeSubscriptionId: 'sub_seed_example',
        status: 'ACTIVE',
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }

  // 3 platform invoices
  const invoiceCount = await prisma.platformInvoice.count({ where: { subscriptionId: subscription.id } });
  if (invoiceCount < 3) {
    await prisma.platformInvoice.createMany({
      data: [
        { subscriptionId: subscription.id, stripeInvoiceId: 'inv_seed_1', amountCents: 3500000, status: 'paid', issuedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), paidAt: new Date(Date.now() - 59 * 24 * 60 * 60 * 1000) },
        { subscriptionId: subscription.id, stripeInvoiceId: 'inv_seed_2', amountCents: 3500000, status: 'paid', issuedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), paidAt: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000) },
        { subscriptionId: subscription.id, stripeInvoiceId: 'inv_seed_3', amountCents: 3500000, status: 'open', issuedAt: new Date() },
      ],
      skipDuplicates: true,
    });
  }
  console.log('✓ Business subscription + invoices');

  // ─────────────────────────────────────────────
  // 5. CLEANERS (3)
  // ─────────────────────────────────────────────
  const cleanerSpecs = [
    { email: 'cleaner1@example.com', phone: '+2348000000011', firstName: 'Tunde', lastName: 'Balogun' },
    { email: 'cleaner2@example.com', phone: '+2348000000012', firstName: 'Ngozi', lastName: 'Okafor' },
    { email: 'cleaner3@example.com', phone: '+2348000000013', firstName: 'Ibrahim', lastName: 'Musa' },
  ];

  const cleaners = [];
  for (const spec of cleanerSpecs) {
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      update: {},
      create: {
        email: spec.email,
        phone: spec.phone,
        passwordHash,
        firstName: spec.firstName,
        lastName: spec.lastName,
        globalRole: 'PLATFORM_USER',
        isEmailVerified: true,
      },
    });

    let profile = await prisma.cleanerProfile.findUnique({ where: { userId: user.id } });
    if (!profile) {
      profile = await prisma.cleanerProfile.create({
        data: {
          businessId: business.id,
          userId: user.id,
          status: 'ACTIVE',
          hireDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          serviceAreaIds: [],
          availability: {
            create: [
              { dayOfWeek: 1, startTime: '08:00', endTime: '17:00' },
              { dayOfWeek: 2, startTime: '08:00', endTime: '17:00' },
              { dayOfWeek: 3, startTime: '08:00', endTime: '17:00' },
              { dayOfWeek: 4, startTime: '08:00', endTime: '17:00' },
              { dayOfWeek: 5, startTime: '08:00', endTime: '17:00' },
            ],
          },
        },
      });
    }
    cleaners.push(profile);
  }
  console.log('✓ Cleaners:', cleaners.length);

  // ─────────────────────────────────────────────
  // 6. CUSTOMERS (3) + addresses
  // ─────────────────────────────────────────────
  const customerSpecs = [
    { firstName: 'Folake', lastName: 'Adeyemi', email: 'folake@email.com', phone: '+2348011111111' },
    { firstName: 'Emeka', lastName: 'Nwosu', email: 'emeka@email.com', phone: '+2348022222222' },
    { firstName: 'Aisha', lastName: 'Bello', email: 'aisha@email.com', phone: '+2348033333333' },
  ];

  const customers = [];
  for (const spec of customerSpecs) {
    let customer = await prisma.customer.findUnique({
      where: { businessId_phone: { businessId: business.id, phone: spec.phone } },
    });
    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          businessId: business.id,
          ...spec,
          notes: 'Seeded customer',
          addresses: {
            create: [
              {
                label: 'Home',
                line1: `${Math.floor(Math.random() * 50) + 1} Palm Avenue`,
                city: 'Lekki',
                state: 'Lagos',
                postalCode: '105102',
                latitude: 6.45,
                longitude: 3.47,
                isPrimary: true,
              },
            ],
          },
        },
        include: { addresses: true },
      });
    } else {
      customer = await prisma.customer.findUnique({
        where: { id: customer.id },
        include: { addresses: true },
      });
    }
    customers.push(customer);
  }
  console.log('✓ Customers:', customers.length);

  // ─────────────────────────────────────────────
  // 7. SERVICES (3) + add-ons
  // ─────────────────────────────────────────────
  const serviceSpecs = [
    {
      name: 'Standard Clean',
      description: 'Regular home cleaning',
      pricingModel: 'FLAT',
      basePriceCents: 2500000,
      estimatedMinutes: 120,
      addOns: [
        { name: 'Inside fridge', priceCents: 300000, extraMinutes: 20 },
        { name: 'Inside oven', priceCents: 400000, extraMinutes: 25 },
      ],
    },
    {
      name: 'Deep Clean',
      description: 'Thorough top-to-bottom clean',
      pricingModel: 'FLAT',
      basePriceCents: 4500000,
      estimatedMinutes: 240,
      addOns: [
        { name: 'Windows (inside)', priceCents: 500000, extraMinutes: 30 },
        { name: 'Cabinet interiors', priceCents: 600000, extraMinutes: 40 },
      ],
    },
    {
      name: 'Move-Out Clean',
      description: 'Full property turnover clean',
      pricingModel: 'FLAT',
      basePriceCents: 6000000,
      estimatedMinutes: 300,
      addOns: [
        { name: 'Carpet shampoo', priceCents: 800000, extraMinutes: 45 },
      ],
    },
  ];

  const services = [];
  for (const spec of serviceSpecs) {
    let service = await prisma.service.findFirst({
      where: { businessId: business.id, name: spec.name },
    });
    if (!service) {
      const { addOns, ...rest } = spec;
      service = await prisma.service.create({
        data: {
          businessId: business.id,
          ...rest,
          addOns: { create: addOns },
        },
      });
    }
    services.push(service);
  }
  console.log('✓ Services:', services.length);

  // ─────────────────────────────────────────────
  // 8. COUPONS (3)
  // ─────────────────────────────────────────────
  const couponSpecs = [
    { code: 'WELCOME10', type: 'PERCENT', value: 10 },
    { code: 'FLAT5000', type: 'AMOUNT', value: 500000 },
    { code: 'DEEP15', type: 'PERCENT', value: 15, appliesToServiceId: services[1]?.id },
  ];

  for (const c of couponSpecs) {
    await prisma.coupon.upsert({
      where: { businessId_code: { businessId: business.id, code: c.code } },
      update: {},
      create: {
        businessId: business.id,
        code: c.code,
        type: c.type,
        value: c.value,
        isActive: true,
        appliesToServiceId: c.appliesToServiceId || null,
        maxRedemptions: 100,
        perCustomerLimit: 1,
      },
    });
  }
  console.log('✓ Coupons: 3');

  // ─────────────────────────────────────────────
  // 9. CHECKLIST TEMPLATES (3)
  // ─────────────────────────────────────────────
  const templates = [
    {
      name: 'Standard Clean',
      items: [
        { label: 'Dust surfaces', done: false },
        { label: 'Vacuum floors', done: false },
        { label: 'Wipe counters', done: false },
        { label: 'Clean bathroom', done: false },
      ],
    },
    {
      name: 'Deep Clean',
      items: [
        { label: 'Clean oven', done: false },
        { label: 'Scrub grout', done: false },
        { label: 'Clean windows inside', done: false },
        { label: 'Wipe baseboards', done: false },
      ],
    },
    {
      name: 'Move-Out Clean',
      items: [
        { label: 'Empty all cabinets', done: false },
        { label: 'Clean behind appliances', done: false },
        { label: 'Wipe walls', done: false },
        { label: 'Final walkthrough', done: false },
      ],
    },
  ];

  for (const t of templates) {
    const existing = await prisma.checklistTemplate.findFirst({
      where: { businessId: business.id, name: t.name },
    });
    if (!existing) {
      await prisma.checklistTemplate.create({
        data: { businessId: business.id, name: t.name, items: t.items },
      });
    }
  }
  console.log('✓ Checklist templates: 3');

  // ─────────────────────────────────────────────
  // 10. BOOKINGS (3) + assignments + checklist + photos + reviews
  // ─────────────────────────────────────────────
  const now = new Date();
  const bookingData = [
    {
      customer: customers[0],
      service: services[0],
      cleaner: cleaners[0],
      status: 'COMPLETED',
      daysAgo: 7,
      price: 2500000,
    },
    {
      customer: customers[1],
      service: services[1],
      cleaner: cleaners[1],
      status: 'CONFIRMED',
      daysAgo: -2, // future
      price: 4500000,
    },
    {
      customer: customers[2],
      service: services[2],
      cleaner: cleaners[2],
      status: 'ASSIGNED',
      daysAgo: -5,
      price: 6000000,
    },
  ];

  const bookings = [];
  for (const bd of bookingData) {
    const start = new Date(now.getTime() + bd.daysAgo * 24 * 60 * 60 * 1000);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + bd.service.estimatedMinutes * 60 * 1000);

    const addr = bd.customer.addresses?.[0];
    let booking = await prisma.booking.findFirst({
      where: {
        businessId: business.id,
        customerId: bd.customer.id,
        serviceId: bd.service.id,
        scheduledStart: start,
      },
    });

    if (!booking) {
      booking = await prisma.booking.create({
        data: {
          businessId: business.id,
          customerId: bd.customer.id,
          serviceId: bd.service.id,
          addressLine1: addr?.line1 || '12 Sample Street',
          city: addr?.city || 'Lagos',
          state: addr?.state || 'Lagos',
          latitude: addr?.latitude,
          longitude: addr?.longitude,
          scheduledStart: start,
          scheduledEnd: end,
          status: bd.status,
          quotedPriceCents: bd.price,
          paymentStatus: bd.status === 'COMPLETED' ? 'PAID' : 'UNPAID',
          assignments: {
            create: {
              cleanerId: bd.cleaner.id,
              assignedAt: new Date(start.getTime() - 24 * 60 * 60 * 1000),
              checkedInAt: bd.status === 'COMPLETED' ? start : null,
              checkedOutAt: bd.status === 'COMPLETED' ? end : null,
              checkInLat: addr?.latitude,
              checkInLng: addr?.longitude,
            },
          },
          checklist:
              bd.status === 'COMPLETED'
                  ? {
                    create: {
                      items: [
                        { label: 'Dust surfaces', done: true },
                        { label: 'Vacuum floors', done: true },
                        { label: 'Wipe counters', done: true },
                      ],
                      completedAt: end,
                    },
                  }
                  : undefined,
          photos:
              bd.status === 'COMPLETED'
                  ? {
                    create: [
                      { stage: 'BEFORE', storageKey: 'seed/before-1.jpg' },
                      { stage: 'AFTER', storageKey: 'seed/after-1.jpg' },
                    ],
                  }
                  : undefined,
        },
      });

      if (bd.status === 'COMPLETED') {
        await prisma.review.create({
          data: {
            businessId: business.id,
            bookingId: booking.id,
            customerId: bd.customer.id,
            rating: 5,
            comment: 'Excellent service, very thorough!',
          },
        });
      }
    }
    bookings.push(booking);
  }
  console.log('✓ Bookings:', bookings.length);

  // ─────────────────────────────────────────────
  // 11. RECURRING SCHEDULES (3)
  // ─────────────────────────────────────────────
  for (let i = 0; i < 3; i++) {
    const customer = customers[i];
    const service = services[i % services.length];
    const addr = customer.addresses?.[0];

    const existing = await prisma.recurringSchedule.findFirst({
      where: { businessId: business.id, customerId: customer.id, serviceId: service.id },
    });
    if (!existing) {
      await prisma.recurringSchedule.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          serviceId: service.id,
          customerAddressId: addr?.id,
          frequency: ['WEEKLY', 'BIWEEKLY', 'MONTHLY'][i],
          dayOfWeek: (i + 1) % 7,
          startTime: '10:00',
          isActive: true,
          nextRunDate: new Date(Date.now() + (i + 1) * 7 * 24 * 60 * 60 * 1000),
        },
      });
    }
  }
  console.log('✓ Recurring schedules: 3');

  // ─────────────────────────────────────────────
  // 12. CONVERSATIONS + MESSAGES (3)
  // ─────────────────────────────────────────────
  for (let i = 0; i < 3; i++) {
    const cleaner = cleaners[i];
    let conv = await prisma.conversation.findFirst({
      where: { businessId: business.id, subjectType: 'CLEANER', subjectId: cleaner.id },
    });
    if (!conv) {
      conv = await prisma.conversation.create({
        data: {
          businessId: business.id,
          subjectType: 'CLEANER',
          subjectId: cleaner.id,
          messages: {
            create: [
              { senderUserId: owner.id, body: `Hi ${cleanerSpecs[i].firstName}, welcome to the team!` },
              { senderUserId: cleaner.userId, body: 'Thank you! Looking forward to working.' },
              { senderUserId: owner.id, body: 'Your first assignment is on the schedule.' },
            ],
          },
        },
      });
    }
  }
  console.log('✓ Conversations + messages: 3');

  // ─────────────────────────────────────────────
  // 13. NOTIFICATIONS (3+)
  // ─────────────────────────────────────────────
  const notifCount = await prisma.notification.count({ where: { businessId: business.id } });
  if (notifCount < 3) {
    await prisma.notification.createMany({
      data: [
        {
          businessId: business.id,
          recipientUserId: owner.id,
          type: 'BOOKING_CONFIRMED',
          title: 'New booking confirmed',
          body: 'A customer confirmed a Standard Clean for next week.',
        },
        {
          businessId: business.id,
          recipientUserId: manager.id,
          type: 'REMINDER',
          title: 'Upcoming jobs tomorrow',
          body: 'You have 2 jobs scheduled for tomorrow.',
        },
        {
          businessId: business.id,
          recipientUserId: cleaners[0].userId,
          type: 'ASSIGNED',
          title: 'New assignment',
          body: 'You have been assigned to a booking.',
        },
      ],
    });
  }
  console.log('✓ Notifications: 3+');

  // ─────────────────────────────────────────────
  // 14. AUDIT LOGS (3)
  // ─────────────────────────────────────────────
  const auditCount = await prisma.auditLog.count({ where: { businessId: business.id } });
  if (auditCount < 3) {
    await prisma.auditLog.createMany({
      data: [
        {
          businessId: business.id,
          actorUserId: owner.id,
          action: 'BUSINESS_CREATED',
          entityType: 'Business',
          entityId: business.id,
          metadata: { source: 'seed' },
        },
        {
          businessId: business.id,
          actorUserId: owner.id,
          action: 'CLEANER_ONBOARDED',
          entityType: 'CleanerProfile',
          entityId: cleaners[0].id,
          metadata: { source: 'seed' },
        },
        {
          businessId: business.id,
          actorUserId: manager.id,
          action: 'BOOKING_ASSIGNED',
          entityType: 'Booking',
          entityId: bookings[0]?.id || 'seed',
          metadata: { source: 'seed' },
        },
      ],
    });
  }
  console.log('✓ Audit logs: 3');

  // ─────────────────────────────────────────────
  // Done
  // ─────────────────────────────────────────────
  console.log('\n────────────────────────────────────');
  console.log('Seed complete!');
  console.log('────────────────────────────────────');
  console.log('Login credentials (password for all):', PASSWORD);
  console.log('  Super Admin : admin@cleansera.com');
  console.log('  Owner       : owner@example.com');
  console.log('  Manager     : manager@example.com');
  console.log('  Cleaners    : cleaner1@example.com, cleaner2@example.com, cleaner3@example.com');
  console.log('  Widget host : example.localhost (or your WIDGET_BASE_DOMAIN)');
  console.log('────────────────────────────────────\n');
}

async function main() {
  try {
    await seed();
  } catch (e) {
    console.error('Seed failed', e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main();