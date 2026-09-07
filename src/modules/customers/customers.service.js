const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');

async function listCustomers(businessId) {
  return prisma.customer.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 200 });
}

async function createCustomer(businessId, payload) {
  const created = await prisma.customer.create({ data: { businessId, ...payload } });
  await audit({ businessId, action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: created.id });
  return created;
}

async function getCustomer(businessId, id) {
  const c = await prisma.customer.findFirst({ where: { id, businessId } });
  if (!c) {
    const err = new Error('Customer not found');
    err.status = 404;
    throw err;
  }
  return c;
}

async function updateCustomer(businessId, id, patch) {
  await getCustomer(businessId, id);
  const updated = await prisma.customer.update({ where: { id }, data: patch });
  await audit({ businessId, action: 'CUSTOMER_UPDATED', entityType: 'Customer', entityId: id, metadata: patch });
  return updated;
}

async function deleteCustomer(businessId, id) {
  await getCustomer(businessId, id);
  await prisma.customer.delete({ where: { id } });
  await audit({ businessId, action: 'CUSTOMER_DELETED', entityType: 'Customer', entityId: id });
}

module.exports = { listCustomers, createCustomer, getCustomer, updateCustomer, deleteCustomer };
