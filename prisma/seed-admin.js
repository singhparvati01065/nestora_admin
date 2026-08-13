// Seeds the super-admin login, CMS content pages, and feature flags.
// Run once after `prisma migrate deploy`:  node prisma/seed-admin.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

const CONTENT = [
  { key: 'faq', title: 'FAQ', body: 'Frequently asked questions will appear here.' },
  { key: 'terms', title: 'Terms of Service', body: 'Terms of service will appear here.' },
  { key: 'privacy', title: 'Privacy Policy', body: 'Privacy policy will appear here.' },
  { key: 'about', title: 'About Us', body: 'About Nestora will appear here.' },
  { key: 'contact', title: 'Contact Us', body: 'Contact details will appear here.' },
];

// Keys are contract: the API gates its modules on them (@RequiresFeature) and
// the app hides the matching entry points. Renaming one silently turns its
// switch back on, so add rather than rename.
const FLAGS = [
  { key: 'amenities', label: 'Amenity booking' },
  { key: 'complaints', label: 'Complaints' },
  { key: 'visitors', label: 'Visitor management' },
  { key: 'online_payments', label: 'Online payments' },
];

async function main() {
  const email = 'admin@nestora.app';
  const password = await bcrypt.hash('admin@123', 10);

  const admin = await prisma.user.upsert({
    where: { email },
    update: { password, role: 'SUPER_ADMIN', banned: false, archivedAt: null },
    create: {
      email,
      password,
      name: 'Super Admin',
      phone: '+910000000000',
      role: 'SUPER_ADMIN',
    },
  });
  console.log('Super-admin ready:', admin.email);

  for (const c of CONTENT) {
    await prisma.contentPage.upsert({
      where: { key: c.key },
      update: {},
      create: c,
    });
  }
  console.log('Content pages ready:', CONTENT.length);

  for (const f of FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: f.key },
      update: {},
      create: { key: f.key, label: f.label, enabled: true },
    });
  }
  console.log('Feature flags ready:', FLAGS.length);

  // Ensure the singleton settings + app-version rows exist.
  await prisma.platformSettings.upsert({ where: { id: 'main' }, update: {}, create: { id: 'main' } });
  await prisma.appConfig.upsert({ where: { id: 'app' }, update: {}, create: { id: 'app' } });

  console.log('SEEDED OK');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
