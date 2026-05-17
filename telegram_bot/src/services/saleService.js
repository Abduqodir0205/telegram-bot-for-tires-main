/**
 * Sale Service (legacy): Chiqim (3.3) va Rabochiy sotuv (3.6) mantiqi.
 * Sotuv bo'lganda chiqim jadvaliga foyda bilan yozish, rabochiy_balon sotuvini saqlash.
 * Barcha operatsiyalar Prisma tranzaksiyasi orqali.
 */
const { prisma } = require('../utils/database');
const inventoryService = require('./inventoryService');

const DEFAULT_SHOP_ID = 1;
/** Birinchi ADMIN_IDS — shopService bilan bir xil (boss). */
const BOSS_ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_IDS?.split(',')[0]) || 222592599;

function isBossTelegram(telegramUserId) {
  return Number(telegramUserId) === BOSS_ADMIN_TELEGRAM_ID;
}

async function upsertAdminByTelegram(telegramIdBigInt, shopId) {
  return prisma.admin.upsert({
    where: { telegramId: telegramIdBigInt },
    create: { telegramId: telegramIdBigInt, shopId },
    update: {},
  });
}

/**
 * sales.admin_id uchun: admins jadvalidan yoki shop_admins / boss asosida avtomatik yaratish.
 * Botda ko'pincha faqat shop_admins bor, admins bo'sh bo'lishi mumkin.
 */
async function resolveAdminIdForSale(shopId, telegramUserId) {
  const sid = shopId ?? DEFAULT_SHOP_ID;

  if (telegramUserId != null) {
    const byTelegram = await prisma.admin.findUnique({
      where: { telegramId: BigInt(telegramUserId) },
    });
    if (byTelegram) return byTelegram.id;
  }

  const inShop = await prisma.admin.findFirst({
    where: { shopId: sid },
    orderBy: { id: 'asc' },
  });
  if (inShop) return inShop.id;

  const any = await prisma.admin.findFirst({ orderBy: { id: 'asc' } });
  if (any) return any.id;

  /** shop_admins yoki boss — admins qatorini yaratamiz (sales.admin_id FK). */
  if (telegramUserId != null) {
    const sa = await prisma.shopAdmin.findUnique({
      where: {
        telegramId_shopId: {
          telegramId: BigInt(telegramUserId),
          shopId: sid,
        },
      },
    });
    if (sa || isBossTelegram(telegramUserId)) {
      const row = await upsertAdminByTelegram(BigInt(telegramUserId), sid);
      return row.id;
    }
  }

  const firstShopAdmin = await prisma.shopAdmin.findFirst({
    where: { shopId: sid },
    orderBy: { telegramId: 'asc' },
  });
  if (firstShopAdmin) {
    const row = await upsertAdminByTelegram(firstShopAdmin.telegramId, sid);
    return row.id;
  }

  throw new Error(
    "Sotuvni saqlab bo'lmadi: admins va shop_admins bo'sh. Do'kon uchun admin (Telegram) qo'shing."
  );
}

/**
 * Chiqim yozuvi + ixtiyoriy rabochiy balonlar omborga qo'shish + sync olinish_kerak.
 * @param {Object} data - razmer, balon_turi, sotildi, umumiy, telegramUserId?, rabochiy_soni?, rabochiy_narx?, rabochiy_razmer?, rabochiy_balon_turi?, rabochiy_holat?
 * @param {number} shopId
 * @returns {{ naqdFoyda, zaxiraFoyda, foyda, rabIds }}
 */
async function saveChiqim(data, shopId = 1) {
  const {
    razmer,
    balon_turi,
    sotildi,
    umumiy,
    telegramUserId,
    rabochiy_soni = 0,
    rabochiy_narx = 0,
    rabochiy_razmer,
    rabochiy_balon_turi,
    rabochiy_holat = 'yaxshi',
  } = data;

  const sid = shopId ?? DEFAULT_SHOP_ID;
  const qty = Math.round(Number(sotildi));
  const total = Number(umumiy);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error("Sotilgan son noto'g'ri.");
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new Error("Umumiy summa noto'g'ri.");
  }

  const tire = await prisma.kirim.findFirst({
    where: { size: razmer, brand: balon_turi, shopId: sid },
    select: { id: true },
  });
  if (!tire) {
    throw new Error(`Kirim topilmadi: ${razmer} | ${balon_turi}. Avval kirim qiling.`);
  }

  const adminId = await resolveAdminIdForSale(sid, telegramUserId);

  const rabochiySumma = rabochiy_soni * rabochiy_narx;
  const naqdTushum = umumiy - rabochiySumma;
  const xarajat = (await inventoryService.getKelganNarx(razmer, balon_turi, shopId)) * sotildi;
  const naqdFoyda = Math.round(naqdTushum - xarajat);
  const zaxiraFoyda = rabochiySumma;
  const foyda = naqdFoyda + zaxiraFoyda;

  const rabIds = [];

  await prisma.$transaction(async (tx) => {
    await tx.chiqim.create({
      data: {
        itemType: 'NEW',
        tireId: tire.id,
        quantity: qty,
        totalPrice: total,
        adminId,
        shopId: sid,
      },
    });

    await tx.warehouseLog.create({
      data: {
        itemType: 'NEW',
        tireId: tire.id,
        usedTireId: null,
        logType: 'OUT',
        quantity: qty,
        price: total,
      },
    });

    if (rabochiy_soni > 0 && rabochiy_razmer && rabochiy_balon_turi) {
      for (let i = 0; i < rabochiy_soni; i++) {
        const r = await tx.rabochiyBalon.create({
          data: {
            razmer: rabochiy_razmer,
            balonTuri: rabochiy_balon_turi,
            soni: 1,
            narx: rabochiy_narx,
            holat: rabochiy_holat,
            shopId: sid,
          },
        });
        rabIds.push(r.id);
      }
    }
  });

  await inventoryService.syncOlinishKerakFromStock(shopId);

  return { naqdFoyda, zaxiraFoyda, foyda, rabIds };
}

/**
 * Rabochiy balonlar savatini sotuv sifatida saqlash: rabochiy_sotuv yozuvlari + rabochiy_balon dan o'chirish.
 * @param {Array<{ id: number, razmer: string, balon_turi: string, narx: number }>} rows
 * @param {number} totalSotilganSumma - jami sotilgan summa (taqsimlanadi)
 * @param {number} shopId
 * @returns {{ count, totalOlingan, sotilganSumma, foyda }}
 */
async function saveRabochiySotuv(rows, totalSotilganSumma, shopId = 1) {
  const totalOlingan = rows.reduce((s, r) => s + Number(r.narx), 0);
  const sotilganPerItem = Math.round(totalSotilganSumma / rows.length);
  const ids = rows.map((r) => r.id);

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      await tx.rabochiySotuv.create({
        data: {
          rabochiyBalonId: row.id,
          razmer: row.razmer,
          balonTuri: row.balon_turi,
          olinganNarx: row.narx,
          sotilganNarx: sotilganPerItem,
          shopId,
        },
      });
    }
    await tx.rabochiyBalon.deleteMany({
      where: { id: { in: ids } },
    });
  });

  const foyda = totalSotilganSumma - totalOlingan;
  return {
    count: rows.length,
    totalOlingan,
    sotilganSumma: totalSotilganSumma,
    foyda,
  };
}

/**
 * Chiqim yozuvlari sana oralig'ida.
 */

/** YYYY-MM-DD yoki Date — mahalliy kalendar kuni (Prisma DateTime `gte`/`lte` uchun to'liq Date). */
function parseCalendarDate(input) {
  if (input instanceof Date) {
    return new Date(input.getFullYear(), input.getMonth(), input.getDate());
  }
  const str = String(input);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfCalendarDay(input) {
  const d = parseCalendarDate(input);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfCalendarDay(input) {
  const d = parseCalendarDate(input);
  d.setHours(23, 59, 59, 999);
  return d;
}

async function getChiqimByDateRange(startDate, endDate, shopId = 1) {
  const sid = shopId ?? DEFAULT_SHOP_ID;
  const gte = startOfCalendarDay(startDate);
  const lte = endOfCalendarDay(endDate);
  return prisma.chiqim.findMany({
    where: {
      createdAt: { gte, lte },
      shopId: sid,
    },
    orderBy: { id: 'desc' },
    include: { kirim: true, usedTire: true },
  });
}

/**
 * Rabochiy sotuv yozuvlari sana oralig'ida.
 */
async function getRabochiySotuvByDateRange(startDate, endDate, shopId = 1) {
  const sid = shopId ?? DEFAULT_SHOP_ID;
  const gte = startOfCalendarDay(startDate);
  const lte = endOfCalendarDay(endDate);
  return prisma.rabochiySotuv.findMany({
    where: {
      sana: { gte, lte },
      shopId: sid,
    },
    orderBy: { id: 'desc' },
  });
}

/**
 * Chiqim jami (umumiy_qiymat, foyda, naqd_foyda, zaxira_foyda) shop va sana bo'yicha.
 */
async function getChiqimTotals(shopId, startDate, endDate = null) {
  const sid = shopId ?? DEFAULT_SHOP_ID;
  const where = { shopId: sid };
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = startOfCalendarDay(startDate);
    if (endDate) where.createdAt.lte = endOfCalendarDay(endDate);
  }

  const agg = await prisma.chiqim.aggregate({
    where,
    _sum: { totalPrice: true, quantity: true },
  });
  const sum = Number(agg._sum.totalPrice || 0);
  const sotildi = Number(agg._sum.quantity || 0);
  return {
    sum,
    foyda: sum,
    naqd_foyda: 0,
    zaxira_foyda: 0,
    sotildi,
  };
}

/**
 * Rabochiy balon qo'shish (bitta yozuv).
 */
async function addRabochiyBalon(razmer, balonTuri, soni, narx, holat, shopId = 1) {
  return prisma.rabochiyBalon.create({
    data: { razmer, balonTuri, soni, narx, holat: holat || 'yaxshi', shopId },
  });
}

module.exports = {
  saveChiqim,
  saveRabochiySotuv,
  getChiqimByDateRange,
  getRabochiySotuvByDateRange,
  getChiqimTotals,
  addRabochiyBalon,
};
