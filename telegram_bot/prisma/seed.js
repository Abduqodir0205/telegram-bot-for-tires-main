const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  // Create SherShina shop
  const shop = await prisma.shop.upsert({
    where: { id: 1 },
    update: {},
    create: {
      name: 'SherShina',
      location: "Toshkent shahri, Yunusobod tumani, Amir Temur ko'chasi 123",
      phone: '+998 90 123 45 67',
      latitude: 41.311081,
      longitude: 69.240562,
    },
  });

  console.log('Created shop:', shop);

  // Add admin (replace with actual Telegram ID)
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
  
  if (adminTelegramId) {
    // normalize to digits only and ensure it's numeric
    const numericId = adminTelegramId.toString().replace(/\D/g, '');
    if (!numericId) {
      console.log('ADMIN_TELEGRAM_ID is not numeric, skipping admin creation.');
    } else {
      const telegramIdNumber = Number(numericId);
      const admin = await prisma.admin.upsert({
        where: { telegramId: telegramIdNumber },
        update: {},
        create: {
          telegramId: telegramIdNumber,
          shopId: shop.id,
        },
      });
      console.log('Created admin with Telegram ID:', adminTelegramId);
    }
  } else {
    console.log('No ADMIN_TELEGRAM_ID set. Add it to .env to create an admin.');
  }

  // Add sample tires
  const sampleTires = [
    { brand: 'Michelin', size: '205/55 R16', priceBuy: 80, priceSell: 100, quantity: 10 },
    { brand: 'Bridgestone', size: '195/65 R15', priceBuy: 70, priceSell: 90, quantity: 15 },
    { brand: 'Continental', size: '225/45 R17', priceBuy: 90, priceSell: 120, quantity: 8 },
    { brand: 'Pirelli', size: '215/60 R16', priceBuy: 85, priceSell: 110, quantity: 12 },
  ];

  for (const tire of sampleTires) {
    await prisma.tire.upsert({
      where: {
        shopId_brand_size: {
          shopId: shop.id,
          brand: tire.brand,
          size: tire.size,
        },
      },
      update: {},
      create: {
        shopId: shop.id,
        ...tire,
      },
    });
  }

  console.log('Added sample tires');

  // Add sample used tires
  const sampleUsedTires = [
    { size: '195/65 R15', condition: 'GOOD', priceBuy: 20, priceSell: 35, quantity: 5 },
    { size: '205/55 R16', condition: 'FAIR', priceBuy: 15, priceSell: 25, quantity: 3 },
  ];

  for (const usedTire of sampleUsedTires) {
    await prisma.usedTire.upsert({
      where: {
        shopId_size_condition: {
          shopId: shop.id,
          size: usedTire.size,
          condition: usedTire.condition,
        },
      },
      update: {},
      create: {
        shopId: shop.id,
        ...usedTire,
      },
    });
  }

  console.log('Added sample used tires');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
