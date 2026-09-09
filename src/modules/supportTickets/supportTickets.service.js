const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');

async function listTickets(businessId, { status, priority, q, page = 1, limit = 20 } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { businessId };
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (q) {
    where.OR = [
      { subject: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [total, tickets] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      skip,
      take,
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
  ]);

  return {
    data: tickets,
    pagination: {
      page: Math.max(parseInt(page, 10) || 1, 1),
      limit: take,
      total,
      totalPages: Math.ceil(total / take) || 1,
    },
  };
}

async function getTicket(businessId, id) {
  const ticket = await prisma.supportTicket.findFirst({
    where: { id, businessId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!ticket) {
    const err = new Error('Ticket not found');
    err.status = 404;
    throw err;
  }
  return ticket;
}

async function createTicket(businessId, actorUserId, body) {
  const ticket = await prisma.supportTicket.create({
    data: {
      businessId,
      subject: body.subject,
      description: body.description,
      priority: body.priority || 'MEDIUM',
      category: body.category || null,
      customerId: body.customerId || null,
      bookingId: body.bookingId || null,
      assignedTo: body.assignedTo || null,
      createdBy: actorUserId,
      status: 'OPEN',
    },
  });
  await audit({
    businessId,
    actorUserId,
    action: 'TICKET_CREATED',
    entityType: 'SupportTicket',
    entityId: ticket.id,
    metadata: { subject: ticket.subject, priority: ticket.priority },
  });
  return ticket;
}

async function updateTicket(businessId, id, actorUserId, body) {
  const existing = await prisma.supportTicket.findFirst({ where: { id, businessId } });
  if (!existing) {
    const err = new Error('Ticket not found');
    err.status = 404;
    throw err;
  }

  const data = {};
  if (body.subject !== undefined) data.subject = body.subject;
  if (body.description !== undefined) data.description = body.description;
  if (body.status !== undefined) data.status = body.status;
  if (body.priority !== undefined) data.priority = body.priority;
  if (body.category !== undefined) data.category = body.category;
  if (body.assignedTo !== undefined) data.assignedTo = body.assignedTo;
  if (body.customerId !== undefined) data.customerId = body.customerId;
  if (body.bookingId !== undefined) data.bookingId = body.bookingId;
  if (body.status === 'RESOLVED' || body.status === 'CLOSED') {
    data.resolvedAt = new Date();
  }

  const ticket = await prisma.supportTicket.update({ where: { id }, data });
  await audit({
    businessId,
    actorUserId,
    action: 'TICKET_UPDATED',
    entityType: 'SupportTicket',
    entityId: id,
    metadata: { previousData: existing, newData: data },
  });
  return ticket;
}

async function addMessage(businessId, ticketId, actorUserId, { body, isInternal }) {
  const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, businessId } });
  if (!ticket) {
    const err = new Error('Ticket not found');
    err.status = 404;
    throw err;
  }
  const message = await prisma.supportTicketMessage.create({
    data: {
      ticketId,
      authorId: actorUserId,
      body,
      isInternal: !!isInternal,
    },
  });
  // bump ticket updatedAt + move out of WAITING if staff replied
  await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      updatedAt: new Date(),
      ...(ticket.status === 'WAITING_ON_CUSTOMER' && !isInternal
        ? { status: 'IN_PROGRESS' }
        : {}),
    },
  });
  return message;
}

async function deleteTicket(businessId, id, actorUserId) {
  const existing = await prisma.supportTicket.findFirst({ where: { id, businessId } });
  if (!existing) {
    const err = new Error('Ticket not found');
    err.status = 404;
    throw err;
  }
  await prisma.supportTicket.delete({ where: { id } });
  await audit({
    businessId,
    actorUserId,
    action: 'TICKET_DELETED',
    entityType: 'SupportTicket',
    entityId: id,
    metadata: { subject: existing.subject },
  });
}

module.exports = {
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  addMessage,
  deleteTicket,
};
