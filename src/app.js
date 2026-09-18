const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const routes = require('./routes');
const stripeWebhookController = require('./modules/webhooks/stripe.controller');
const bodyParser = require('body-parser');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const app = express();

// ---------- Swagger setup ----------
const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'CleanSera API',
            version: '0.1.0',
            description: 'Multi-tenant cleaning business SaaS backend',
        },
        servers: [
            { url: 'http://localhost:8000/api/v1', description: 'Local' },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
        security: [{ bearerAuth: [] }],
    },
    // Absolute paths so it works no matter where you start the process
    apis: [
        path.join(__dirname, 'modules/**/*.routes.js'),
        path.join(__dirname, 'routes/*.js'),
    ],
};

const specs = swaggerJsdoc(options);

// Mount docs BEFORE helmet so CSP does not break the UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs, {
    explorer: true,
    customSiteTitle: 'CleanSera API Docs',
}));

// ---------- Normal middleware ----------
app.use(helmet({
    contentSecurityPolicy: false, // simplest fix while developing docs
    // or keep CSP and only disable it for /api-docs if you prefer
}));

app.use(
    cors({
        origin: true,
        credentials: false,
    })
);

// Stripe webhook must stay before express.json()
app.post(
    '/api/v1/webhooks/stripe',
    bodyParser.raw({ type: 'application/json' }),
    (req, res, next) => {
        req.rawBody = req.body;
        return stripeWebhookController.handle(req, res, next);
    }
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(apiLimiter);

app.get('/health', (req, res) =>
    res.json({ status: 'ok', service: 'cleansera-api' })
);

app.use('/api/v1', routes);

app.use((req, res) =>
    res.status(404).json({ success: false, message: 'Route not found' })
);
app.use(errorHandler);

module.exports = app;