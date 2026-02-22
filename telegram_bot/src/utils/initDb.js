/**
 * Bazaga ulanish va Prisma modellarining mavjudligini tekshirish.
 * Jadvalar Prisma schema (db push / migrate) orqali yaratilgan bo'lishi kerak.
 * Raw SQL ishlatilmaydi.
 */
const { prisma } = require('./database');

async function runInit() {
  await prisma.$connect();
  const shop = await prisma.shop.findFirst();
  if (!shop) {
    await prisma.shop.create({
      data: {
        id: 1,
        name: "SherShina",
        phone: "+998 90 123 45 67",
        location: "Toshkent shahri",
        latitude: 41.311081,
        longitude: 69.240562,
      },
    }).catch(() => {});
  }
  console.log("Database connection OK (Prisma)");
}

module.exports = { runInit };
