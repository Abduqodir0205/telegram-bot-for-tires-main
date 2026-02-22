/**
 * Sale Service (legacy): Chiqim (3.3) va Rabochiy sotuv (3.6) mantiqi.
 * Sotuv bo'lganda chiqim jadvaliga foyda bilan yozish, rabochiy_balon sotuvini saqlash.
 * Barcha operatsiyalar Prisma tranzaksiyasi orqali.
 */
const { prisma } = require('../utils/database');
const logger = require('../utils/logger');
const inventoryService = require('./inventoryService');

/**
 * Chiqim yozuvi + ixtiyoriy rabochiy balonlar omborga qo'shish + sync olinish_kerak.
 * @param {Object} data - razmer, balon_turi, sotildi, umumiy, rabochiy_soni?, rabochiy_narx?, rabochiy_razmer?, rabochiy_balon_turi?, rabochiy_holat?
 * @param {number} shopId
 * @returns {{ naqdFoyda, zaxiraFoyda, foyda, rabIds }}
 */
async function saveChiqim(data, shopId = 1) {
  const {
    razmer,
    balon_turi,
    sotildi,
    umumiy,
    rabochiy_soni = 0,
    rabochiy_narx = 0,
    rabochiy_razmer,
    rabochiy_balon_turi,
    rabochiy_holat = 'yaxshi',
  } = data;

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
        razmer,
        balonTuri: balon_turi,
        sotildi,
        umumiyQiymat: umumiy,
        foyda,
        naqdFoyda,
        zaxiraFoyda,
        rabochiyOlindi: rabochiy_soni,
        rabochiyNarxi: rabochiy_narx,
        shopId,
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
            shopId,
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
const DEFAULT_SHOP_ID = 1;

async function getChiqimByDateRange(startDate, endDate, shopId = 1) {
  const sid = shopId ?? DEFAULT_SHOP_ID;
  return prisma.chiqim.findMany({
    where: {
      createdAt: { gte: startDate, lte: endDate },
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
  return prisma.rabochiySotuv.findMany({
    where: {
      sana: { gte: startDate, lte: endDate },
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
    if (startDate) where.createdAt.gte = startDate;
    if (endDate) where.createdAt.lte = endDate;
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
