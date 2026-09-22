/**
 * Polls PENDING custom domains and verifies ownership automatically, so a
 * business doesn't have to keep clicking "verify" after adding the TXT
 * record — Vercel/Netlify-style auto-detection. Run alongside the existing
 * notification-worker / recurring-daemon (see package.json scripts and
 * deploy/systemd, deploy/k8s for the pattern to add this one the same way).
 *
 * Usage: node src/workers/domainVerificationWorker.js
 * Env:   DOMAIN_VERIFICATION_POLL_MS (default 5 min)
 */
const prisma = require('../config/database');
const logger = require('../config/logger');
const { checkOwnership } = require('../modules/domains/domains.service');
const { audit } = require('../utils/audit');

const POLL_MS = Number(process.env.DOMAIN_VERIFICATION_POLL_MS || 5 * 60 * 1000);

async function tick() {
  const pending = await prisma.business.findMany({
    where: { customDomainStatus: 'PENDING' },
    select: { id: true, customDomain: true, customDomainVerificationToken: true },
  });

  for (const business of pending) {
    try {
      const ok = await checkOwnership(business);
      if (!ok) continue; // still pending, try again next tick
      await prisma.business.update({
        where: { id: business.id },
        data: { customDomainStatus: 'VERIFIED', customDomainVerifiedAt: new Date() },
      });
      await audit({
        businessId: business.id,
        action: 'CUSTOM_DOMAIN_VERIFIED',
        entityType: 'Business',
        entityId: business.id,
        metadata: { via: 'domainVerificationWorker' },
      });
      logger.info(`Custom domain verified: ${business.customDomain} (business ${business.id})`);
    } catch (err) {
      logger.error(`Domain verification check failed for ${business.customDomain}: ${err.message}`);
    }
  }
}

async function main() {
  logger.info(`Domain verification worker started — polling every ${POLL_MS}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick().catch((err) => logger.error(`domainVerificationWorker tick failed: ${err.message}`));
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

if (require.main === module) {
  main();
}

module.exports = { tick };
