const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function ensureBusiness() {
  let b = await prisma.business.findFirst();
  if (!b) {
    b = await prisma.business.create({
      data: {
        name: 'Example Business',
        subdomain: 'example',
        branding: { create: {} },
        hours: {
          create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            dayOfWeek,
            openTime: '08:00',
            closeTime: '18:00',
            isClosed: dayOfWeek === 0,
          })),
        },
      },
    });
    console.log('Created example business', b.id);
  }
  return b;
}

async function seedChecklistTemplates() {
  const business = await ensureBusiness();

  const templates = [
    {
      name: 'Standard Clean',
      items: [
        { label: 'Dust surfaces', done: false },
        { label: 'Vacuum floors', done: false },
        { label: 'Wipe counters', done: false },
      ],
    },
    {
      name: 'Deep Clean',
      items: [
        { label: 'Clean oven', done: false },
        { label: 'Scrub grout', done: false },
        { label: 'Clean windows inside', done: false },
      ],
    },
  ];

  for (const t of templates) {
    const existing = await prisma.checklistTemplate.findFirst({ where: { businessId: business.id, name: t.name } });
    if (!existing) {
      await prisma.checklistTemplate.create({ data: { businessId: business.id, name: t.name, items: t.items } });
      console.log('Created checklist template', t.name);
    } else {
      console.log('Template exists, skipping', t.name);
    }
  }
}

async function main() {
  try {
    await seedChecklistTemplates();
  } catch (e) {
    console.error('Seed failed', e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main();
