#!/usr/bin/env node
/**
 * Read-only audit. Lists businesses that already hold a reserved subdomain
 * (registered before the reserved list existed). Nothing is changed.
 *
 *   node scripts/list-reserved-subdomains.js
 *
 * Their storefronts cannot work on <name>.<root domain> - the frontend refuses
 * to serve a reserved host. Contact each business and move them to a new name
 * (or a custom domain) by hand; renaming a subdomain breaks their existing links.
 */
const prisma = require('../src/config/database');
const { RESERVED_SLUGS } = require('../src/lib/reservedSlugs');

async function main() {
  const rows = await prisma.business.findMany({
    where: { subdomain: { in: [...RESERVED_SLUGS] } },
    select: { id: true, name: true, subdomain: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!rows.length) {
    console.log('No existing business uses a reserved subdomain.');
    return;
  }
  console.log(`${rows.length} business(es) use a reserved subdomain:\n`);
  for (const b of rows) {
    console.log(`  ${b.subdomain.padEnd(20)} ${b.id}  ${b.isActive ? 'active  ' : 'inactive'}  ${b.name}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
