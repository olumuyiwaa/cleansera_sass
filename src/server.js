require('dotenv').config();
const http = require('http');
const app = require('./app');
const { initSocket } = require('./config/socket');
const logger = require('./config/logger');

const PORT = process.env.PORT || 8000;

const server = http.createServer(app);
initSocket(server);

server.listen(PORT, () => {
  logger.info(`CleanSera API listening on port ${PORT}`);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { message: err.message, stack: err.stack });
});
