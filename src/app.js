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
// Stripe requires the raw, unparsed body for webhook signature verification.
// This MUST be registered before express.json() below — once express.json()
// runs on a request, the stream is consumed and Stripe's signature check
// against bodyParser.raw() will always fail.
app.post('/api/v1/webhooks/stripe', bodyParser.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body;
  return stripeWebhookController.handle(req, res, next);
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(apiLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'cleansera-api' }));

app.use('/api/v1', routes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use(errorHandler);

module.exports = app;
