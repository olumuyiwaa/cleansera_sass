const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');

// ---------------------------------------------------------------------------
// Platform overview KPIs
// ---------------------------------------------------------------------------
async function getOverview() {
  const [
    totalBusinesses,
    activeBusinesses,
    totalUsers,
    totalCleaners,
    totalCustomers,
    totalBookings,
    openTickets,
    subscriptionsByStatus,
    recentBusinesses,
    mrrAgg,
  ] = await Promise.all([
    prisma.business.count(),
    prisma.business.count({ where: { isActive: true } }),
    prisma.user.count({ where: { globalRole: 'PLATFORM_USER' } }),
    prisma.cleanerProfile.count({ where: { status: 'ACTIVE' } }),
    prisma.customer.count(),
    prisma.booking.count(),
    prisma.supportTicket.count({
      where: { status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER'] } },
    }),
    prisma.businessSubscription.groupBy({
      by: ['status'],
      _count: { status: true },
    }),
    prisma.business.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        name: true,
        subdomain: true,
        isActive: true,
        createdAt: true,
        stripeConnectOnboarded: true,
        subscription: {
          select: {
            status: true,
            plan: { select: { name: true, monthlyPriceCents: true } },
          },
        },
        _count: { select: { cleaners: true, customers: true, bookings: true } },
      },
    }),
    prisma.businessSubscription.findMany({
      where: { status: { in: ['ACTIVE', 'TRIALING'] } },
      include: { plan: { select: { monthlyPriceCents: true } } },
    }),
  ]);

  const subscriptionBreakdown = {
    TRIALING: 0,
    ACTIVE: 0,
    PAST_DUE: 0,
    CANCELED: 0,
  };
  for (const row of subscriptionsByStatus) {
    subscriptionBreakdown[row.status] = row._count.status;
  }

  const mrrCents = mrrAgg.reduce(
    (sum, s) => sum + (s.plan?.monthlyPriceCents || 0),
    0
  );

  return {
    kpis: {
      totalBusinesses,
      activeBusinesses,
      inactiveBusinesses: totalBusinesses - activeBusinesses,
      totalUsers,
      totalCleaners,
      totalCustomers,
      totalBookings,
      openTickets,
      mrrCents,
      mrrFormatted: (mrrCents / 100).toFixed(2),
    },
    subscriptionBreakdown,
    recentBusinesses,
  };
}

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------
async function listBusinesses({ q, isActive, page = 1, limit = 20 } = {}) {
  const where = {};
  if (typeof isActive === 'boolean') where.isActive = isActive;
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { subdomain: { contains: term, mode: 'insensitive' } },
      { customDomain: { contains: term, mode: 'insensitive' } },
    ];
  }

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.business.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        name: true,
        subdomain: true,
        customDomain: true,
        timezone: true,
        isActive: true,
        createdAt: true,
        stripeConnectOnboarded: true,
        stripeChargesEnabled: true,
        parentBusinessId: true,
        subscription: {
          select: {
            id: true,
            status: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            plan: {
              select: {
                id: true,
                name: true,
                monthlyPriceCents: true,
                maxCleaners: true,
              },
            },
          },
        },
        _count: {
          select: {
            cleaners: true,
            customers: true,
            bookings: true,
            members: true,
          },
        },
      },
    }),
    prisma.business.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page: Math.max(1, page),
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

async function getBusiness(id) {
  const business = await prisma.business.findUnique({
    where: { id },
    include: {
      branding: true,
      subscription: { include: { plan: true, invoices: { take: 10, orderBy: { issuedAt: 'desc' } } } },
      members: {
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              isActive: true,
            },
          },
        },
      },
      _count: {
        select: {
          cleaners: true,
          customers: true,
          bookings: true,
          services: true,
          supportTickets: true,
        },
      },
    },
  });
  if (!business) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  return business;
}

async function setBusinessActive(id, isActive, actorUserId) {
  const business = await prisma.business.findUnique({ where: { id } });
  if (!business) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }

  const updated = await prisma.business.update({
    where: { id },
    data: { isActive: Boolean(isActive) },
    select: {
      id: true,
      name: true,
      subdomain: true,
      isActive: true,
    },
  });

  await audit({
    businessId: id,
    actorUserId,
    action: isActive ? 'SUPER_ADMIN_ACTIVATE_BUSINESS' : 'SUPER_ADMIN_DEACTIVATE_BUSINESS',
    entityType: 'Business',
    entityId: id,
    metadata: { previous: business.isActive, next: updated.isActive },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Subscriptions (platform billing)
// ---------------------------------------------------------------------------
async function listSubscriptions({ status, page = 1, limit = 20 } = {}) {
  const where = {};
  if (status) where.status = status;

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.businessSubscription.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        plan: true,
        business: {
          select: {
            id: true,
            name: true,
            subdomain: true,
            isActive: true,
          },
        },
      },
    }),
    prisma.businessSubscription.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page: Math.max(1, page),
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

async function listPlans() {
  return prisma.subscriptionPlan.findMany({
    orderBy: { monthlyPriceCents: 'asc' },
    include: {
      _count: { select: { subscriptions: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Users (platform-wide)
// ---------------------------------------------------------------------------
async function listUsers({ q, globalRole, page = 1, limit = 20 } = {}) {
  const where = {};
  if (globalRole) where.globalRole = globalRole;
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { email: { contains: term, mode: 'insensitive' } },
      { firstName: { contains: term, mode: 'insensitive' } },
      { lastName: { contains: term, mode: 'insensitive' } },
      { phone: { contains: term, mode: 'insensitive' } },
    ];
  }

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        globalRole: true,
        isActive: true,
        isEmailVerified: true,
        createdAt: true,
        businessMemberships: {
          where: { isActive: true },
          select: {
            role: true,
            business: { select: { id: true, name: true, subdomain: true } },
          },
        },
        cleanerProfiles: {
          select: {
            id: true,
            status: true,
            business: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page: Math.max(1, page),
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

async function setUserActive(id, isActive, actorUserId) {
  if (id === actorUserId) {
    const err = new Error('You cannot deactivate your own account');
    err.status = 400;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: Boolean(isActive) },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      globalRole: true,
      isActive: true,
    },
  });

  await audit({
    actorUserId,
    action: isActive ? 'SUPER_ADMIN_ACTIVATE_USER' : 'SUPER_ADMIN_DEACTIVATE_USER',
    entityType: 'User',
    entityId: id,
    metadata: { email: user.email },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Support tickets (platform-wide)
// ---------------------------------------------------------------------------
async function listTickets({ status, page = 1, limit = 20 } = {}) {
  const where = {};
  if (status) where.status = status;

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        business: {
          select: { id: true, name: true, subdomain: true },
        },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page: Math.max(1, page),
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

async function updateTicketStatus(id, status, actorUserId) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id } });
  if (!ticket) {
    const err = new Error('Ticket not found');
    err.status = 404;
    throw err;
  }

  const updated = await prisma.supportTicket.update({
    where: { id },
    data: { status },
    include: {
      business: { select: { id: true, name: true, subdomain: true } },
    },
  });

  await audit({
    businessId: ticket.businessId,
    actorUserId,
    action: 'SUPER_ADMIN_UPDATE_TICKET',
    entityType: 'SupportTicket',
    entityId: id,
    metadata: { previous: ticket.status, next: status },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Audit log (platform-wide)
// ---------------------------------------------------------------------------
async function listAuditLogs({ action, businessId, page = 1, limit = 30 } = {}) {
  const where = {};
  if (action) where.action = action;
  if (businessId) where.businessId = businessId;

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page: Math.max(1, page),
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

module.exports = {
  getOverview,
  listBusinesses,
  getBusiness,
  setBusinessActive,
  listSubscriptions,
  listPlans,
  listUsers,
  setUserActive,
  listTickets,
  updateTicketStatus,
  listAuditLogs,
};
