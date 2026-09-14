require('dotenv').config();
const http = require('http');
const app = require('./app');
const { initSocket } = require('./config/socket');
const logger = require('./config/logger');

// The pricing page ("never a percentage of what your customers pay you")
// and the Terms of Service ("CleanSera does not charge a commission on
// jobs booked through a business's site") both promise this is 0. That
// promise is only as good as this env var — nothing else in the code
// re-checks it — so refuse to start rather than let a stray config change
// silently break it in production. See .env.example for the full context.
const platformFeeBps = parseInt(process.env.PLATFORM_APPLICATION_FEE_BPS || '0', 10);
if (Number.isFinite(platformFeeBps) && platformFeeBps > 0) {
  logger.error(
    `PLATFORM_APPLICATION_FEE_BPS is set to ${platformFeeBps} (non-zero). This contradicts the ` +
    `no-commission promise on the pricing page and in the Terms of Service — refusing to start. ` +
    `Update the marketing copy first if the business model has actually changed, then raise this.`
  );
  process.exit(1);
}

const PORT = process.env.PORT || 8000;

const server = http.createServer(app);
initSocket(server);

server.listen(PORT, () => {
  logger.info(`CleanSera API listening on port ${PORT}`);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { message: err.message, stack: err.stack });
});
