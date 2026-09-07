const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('./logger');

let io;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: process.env.FRONTEND_URL, credentials: true },
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = payload.sub;
      socket.businessId = payload.businessId || null;
      next();
    } catch (err) {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    if (socket.businessId) socket.join(`business:${socket.businessId}`);

    socket.on('join_conversation', (conversationId) => socket.join(`conversation:${conversationId}`));
    socket.on('leave_conversation', (conversationId) => socket.leave(`conversation:${conversationId}`));
    socket.on('typing', ({ conversationId }) => {
      socket.to(`conversation:${conversationId}`).emit('user_typing', { userId: socket.userId });
    });

    socket.on('disconnect', () => logger.debug(`socket disconnected: ${socket.id}`));
  });

  return io;
}

function getIo() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

module.exports = { initSocket, getIo };
