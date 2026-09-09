const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');

async function listCustomers(businessId, { q, take = 200 } = {}) {
  const where = { businessId };
  if (q) {
    where.OR = [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
      { email: { contains: q, mode: 'insensitive' } },
    ];
  }
  return prisma.customer.findMany({
    where,
    include: {
      addresses: true,
      _count: { select: { bookings: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(take) || 200, 500),
  });
}

async function createCustomer(businessId, actorUserId, payload) {
  const { firstName, lastName, email, phone, notes, address } = payload;
  const created = await prisma.customer.create({
    data: {
      businessId,
      firstName,
      lastName,
      email: email || null,
      phone,
      notes: notes || null,
      ...(address
        ? {
            addresses: {
              create: {
                label: address.label || 'Primary',
                line1: address.line1,
                line2: address.line2 || null,
                city: address.city,
                state: address.state,
                postalCode: address.postalCode || '',
                latitude: address.latitude ?? null,
                longitude: address.longitude ?? null,
                isPrimary: true,
              },
            },
          }
        : {}),
    },
    include: { addresses: true },
  });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: created.id });
  return created;
}

async function getCustomer(businessId, id) {
  const c = await prisma.customer.findFirst({
    where: { id, businessId },
    include: {
      addresses: true,
      bookings: {
        orderBy: { scheduledStart: 'desc' },
        take: 50,
        include: { service: true, assignments: { include: { cleaner: { include: { user: true } } } } },
      },
      recurringSchedules: { where: { isActive: true } },
      reviews: true,
    },
  });
  if (!c) {
    const err = new Error('Customer not found');
    err.status = 404;
    throw err;
  }
  return c;
}

async function updateCustomer(businessId, id, actorUserId, patch) {
  await getCustomer(businessId, id);
  const allowed = ['firstName', 'lastName', 'email', 'phone', 'notes'];
  const data = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) data[k] = patch[k];
  }
  const updated = await prisma.customer.update({ where: { id }, data, include: { addresses: true } });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_UPDATED', entityType: 'Customer', entityId: id, metadata: data });
  return updated;
}

async function deleteCustomer(businessId, id, actorUserId) {
  await getCustomer(businessId, id);
  // Soft approach: refuse if they have future bookings
  const future = await prisma.booking.count({
    where: {
      customerId: id,
      businessId,
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
      scheduledStart: { gte: new Date() },
    },
  });
  if (future > 0) {
    const err = new Error('Cannot delete customer with upcoming bookings — cancel them first');
    err.status = 422;
    throw err;
  }
  await prisma.customer.delete({ where: { id } });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_DELETED', entityType: 'Customer', entityId: id });
}

async function addAddress(businessId, customerId, actorUserId, payload) {
  await getCustomer(businessId, customerId);
  if (payload.isPrimary) {
    await prisma.customerAddress.updateMany({ where: { customerId }, data: { isPrimary: false } });
  }
  const address = await prisma.customerAddress.create({
    data: {
      customerId,
      label: payload.label || null,
      line1: payload.line1,
      line2: payload.line2 || null,
      city: payload.city,
      state: payload.state,
      postalCode: payload.postalCode || '',
      latitude: payload.latitude ?? null,
      longitude: payload.longitude ?? null,
      isPrimary: !!payload.isPrimary,
    },
  });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_ADDRESS_ADDED', entityType: 'CustomerAddress', entityId: address.id });
  return address;
}

async function updateAddress(businessId, customerId, addressId, actorUserId, patch) {
  const address = await prisma.customerAddress.findFirst({
    where: { id: addressId, customerId, customer: { businessId } },
  });
  if (!address) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  if (patch.isPrimary) {
    await prisma.customerAddress.updateMany({ where: { customerId }, data: { isPrimary: false } });
  }
  const allowed = ['label', 'line1', 'line2', 'city', 'state', 'postalCode', 'latitude', 'longitude', 'isPrimary'];
  const data = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) data[k] = patch[k];
  }
  const updated = await prisma.customerAddress.update({ where: { id: addressId }, data });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_ADDRESS_UPDATED', entityType: 'CustomerAddress', entityId: addressId });
  return updated;
}

async function deleteAddress(businessId, customerId, addressId, actorUserId) {
  const address = await prisma.customerAddress.findFirst({
    where: { id: addressId, customerId, customer: { businessId } },
  });
  if (!address) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  await prisma.customerAddress.delete({ where: { id: addressId } });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_ADDRESS_DELETED', entityType: 'CustomerAddress', entityId: addressId });
}

module.exports = {
  listCustomers,
  createCustomer,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  addAddress,
  updateAddress,
  deleteAddress,
};
