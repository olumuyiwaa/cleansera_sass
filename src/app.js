const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const routes = require('./routes');
const stripeWebhookController = require('./modules/webhooks/stripe.controller');
const bodyParser = require('body-parser');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: true, // reflects request origin — needed since widget requests come from arbitrary business domains
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(apiLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'cleansera-api' }));

// Stripe requires raw body for webhook signature verification
app.post('/api/v1/webhooks/stripe', bodyParser.raw({ type: 'application/json' }), (req, res, next) => {
  // attach raw body for controller to verify
  req.rawBody = req.body;
  return stripeWebhookController.handle(req, res, next);
});

app.use('/api/v1', routes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use(errorHandler);

module.exports = app;
