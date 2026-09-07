const prisma = require('../../config/database');

async function listConversations(businessId) {
  return prisma.conversation.findMany({ where: { businessId }, include: { messages: { orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 200 });
}

module.exports = { listConversations };

async function createConversation(businessId, { subjectType, subjectId }) {
  return prisma.conversation.create({ data: { businessId, subjectType, subjectId } });
}

async function postMessage(businessId, conversationId, senderUserId, { body, attachmentKey }) {
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId, businessId } });
  if (!conv) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  return prisma.message.create({ data: { conversationId, senderUserId, body, attachmentKey } });
}

module.exports = { listConversations, createConversation, postMessage };
