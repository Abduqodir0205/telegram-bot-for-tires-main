/**
 * Inventory Service: Skladdagi yangi va rabochiy balonlar qoldig'i, kirim, sklad hisobotlari (TZ 3.2, 3.3, 3.6).
 * Barcha mantiq markazlashgan; bot va API faqat shu servis orqali DB ga murojaat qiladi.
 */
const { prisma } = require('../utils/database');
const logger = require('../utils/logger');
const shopService = require('./shopService');
const legacyData = require('./legacyDataService');

/**
 * Yangi shinalar (Prisma Tire) bo'yicha shop qoldig'i — umumiy dona va ro'yxat.
 * @param {number} shopId
 * @returns {{ totalQuantity: number, items: Array<{ id, brand, size, quantity, priceBuy, priceSell }> }}
 */
async function getNewTireBalance(shopId) {
  const items = await prisma.kirim.findMany({
    where: { shopId },
    select: { id: true, brand: true, size: true, quantity: true, priceBuy: true, priceSell: true },
    orderBy: [{ brand: 'asc' }, { size: 'asc' }],
  });
  const totalQuantity = items.reduce((sum, t) => sum + t.quantity, 0);
  return { totalQuantity, items };
}

/**
 * Ishchi (used) shinalar (Prisma UsedTire) bo'yicha shop qoldig'i.
 * @param {number} shopId
 * @returns {{ totalQuantity: number, items: Array<{ id, size, condition, quantity, priceBuy, priceSell }> }}
 */
async function getUsedTireBalance(shopId) {
  const items = await prisma.usedTire.findMany({
    where: { shopId },
    select: { id: true, size: true, condition: true, quantity: true, priceBuy: true, priceSell: true },
    orderBy: [{ size: 'asc' }, { condition: 'asc' }],
  });
  const totalQuantity = items.reduce((sum, t) => sum + t.quantity, 0);
  return { totalQuantity, items };
}

/**
 * Rabochiy balonlar (legacy jadval rabochiy_balon) qoldig'i — faqat soni > 0.
 * shop_id bo'yicha filtrlash: shopId yoki null (umumiy).
 * @param {number} shopId
 * @returns {{ totalQuantity: number, items: Array<{ id, razmer, balonTuri, soni, narx, holat }> }}
 */
const DEFAULT_SHOP_ID = 1;

async function getRabochiyBalonBalance(shopId) {
  const sid = shopId ?? DEFAULT_SHOP_ID;
  const items = await prisma.rabochiyBalon.findMany({
    where: {
      soni: { gt: 0 },
      shopId: sid,
    },
    select: { id: true, razmer: true, balonTuri: true, soni: true, narx: true, holat: true },
    orderBy: [{ razmer: 'asc' }],
  });
  const totalQuantity = items.reduce((sum, r) => sum + r.soni, 0);
  return { totalQuantity, items };
}

/**
 * Bitta shop uchun barcha sklad qoldiqlari: yangi shina, ishchi shina, rabochiy balon.
 * @param {number} shopId
 */
async function getFullInventorySummary(shopId) {
  try {
    const [newTires, usedTires, rabochiyBalon] = await Promise.all([
      getNewTireBalance(shopId),
      getUsedTireBalance(shopId),
      getRabochiyBalonBalance(shopId),
    ]);
    return {
      shopId,
      newTires,
      usedTires,
      rabochiyBalon,
    };
  } catch (error) {
    logger.error('inventoryService.getFullInventorySummary:', error);
    throw error;
  }
}

/**
 * OCR / Gemini dan kelgan kirim batch ni kirim jadvaliga saqlash (sizes, brands orqali).
 * @param {Array<{ size: string, brand: string, quantity: number, price?: number, selling_price?: number }>} rows
 * @param {number} shopId
 * @param {{ sizeToDbFormat?: (s) => string }} options
 * @returns {{ saved: number, errors: number }}
 */
async function addKirimBatch(rows, shopId, options = {}) {
  const sizeToDb = options.sizeToDbFormat || ((s) => s);
  let saved = 0;
  let errors = 0;
  for (const r of rows) {
    const razmer = sizeToDb(r.size) || r.size;
    const balonTuri = (r.brand && String(r.brand).trim()) || "Noma'lum";
    const soni = Math.max(0, Math.round(Number(r.quantity) || 0));
    const kelganNarx = Math.round(Number(r.price) || 0);
    let sotishNarx = Math.round(Number(r.selling_price) || kelganNarx + 1);
    if (sotishNarx <= kelganNarx) sotishNarx = kelganNarx + 1;
    const umumiyQiymat = soni * sotishNarx;
    if (soni < 1) continue;
    try {
      await prisma.size.upsert({ where: { name: razmer }, create: { name: razmer }, update: {} });
      await prisma.brand.upsert({ where: { name: balonTuri }, create: { name: balonTuri }, update: {} });
      await legacyData.createKirim({
        razmer,
        balon_turi: balonTuri,
        soni,
        kelgan_narx: kelganNarx,
        sotish_narx: sotishNarx,
        umumiy_qiymat: umumiyQiymat,
        shop_id: shopId,
      });
      saved++;
    } catch (e) {
      logger.error('addKirimBatch row error:', e.message, r);
      errors++;
    }
  }
  return { saved, errors };
}

/**
 * Chiqim uchun o'rtacha kelgan narx (kirim bo'yicha, dollar_kurs hisobga olinadi).
 */
async function getKelganNarx(razmer, balonTuri, shopId = 1) {
  const sid = shopId ?? DEFAULT_SHOP_ID;
  const rows = await prisma.kirim.findMany({
    where: {
      size: razmer,
      brand: balonTuri,
      shopId: sid,
    },
    select: { priceBuy: true },
  });
  if (!rows.length) return 0;
  const sum = rows.reduce((s, r) => s + Number(r.priceBuy || 0), 0);
  return Math.round(sum / rows.length);
}

/**
 * Berilgan razmer uchun skladda bor brendlar (qoldiq > 0).
 */
async function getBrandsWithStock(razmer, shopId = 1) {
  const sid = shopId ?? DEFAULT_SHOP_ID;
  const rows = await prisma.kirim.findMany({
    where: { size: razmer, shopId: sid },
    select: { id: true, brand: true, quantity: true },
  });
  const out = [];
  for (const r of rows) {
    const stock = await legacyData.getStock(razmer, r.brand, shopId);
    if (stock > 0) out.push(r.brand);
  }
  return [...new Set(out)].sort();
}

/**
 * Skladda qoldiq > 0 bo'lgan razmerlar (legacy kirim/chiqim hisobi).
 */
async function getSizesWithStock(shopId = 1) {
  return legacyData.getDistinctRazmerWithStock(shopId);
}

/**
 * Sklad qoldiqlari va tannarx (legacy kirim/chiqim) — hisobot va Excel uchun.
 */
async function getSkladRowsWithValuation(shopId = 1) {
  const rows = await prisma.$queryRaw`
    WITH agg AS (
      SELECT t.size AS razmer, t.brand AS balon_turi, COALESCE(SUM(t.quantity), 0)::int AS kirdi, ROUND(AVG(t.price_buy))::int AS tan_narx
      FROM tires t WHERE (t.shop_id IS NULL OR t.shop_id = ${shopId}) GROUP BY t.size, t.brand
    ),
    outgo AS (
      SELECT t.size AS razmer, t.brand AS balon_turi, COALESCE(SUM(s.quantity), 0)::int AS sotildi
      FROM sales s INNER JOIN tires t ON s.tire_id = t.id
      WHERE s.item_type = 'NEW' AND (s.shop_id IS NULL OR s.shop_id = ${shopId}) GROUP BY t.size, t.brand
    ),
    qoldiq AS (
      SELECT a.razmer, a.balon_turi, GREATEST(0, a.kirdi - COALESCE(o.sotildi, 0))::int AS q, a.tan_narx
      FROM agg a LEFT JOIN outgo o ON a.razmer = o.razmer AND a.balon_turi = o.balon_turi
    ),
    last_sotish AS (
      SELECT DISTINCT ON (size, brand) size AS razmer, brand AS balon_turi, price_sell AS sotish_narx
      FROM tires WHERE (shop_id IS NULL OR shop_id = ${shopId}) ORDER BY size, brand, id DESC
    ),
    with_kirdi AS (SELECT a.razmer, a.balon_turi, a.kirdi FROM agg a)
    SELECT q.razmer, q.balon_turi, k.kirdi, (k.kirdi - q.q) AS sotildi, q.q AS qoldiq, q.tan_narx, COALESCE(s.sotish_narx, 0) AS sotish_narx
    FROM qoldiq q
    JOIN with_kirdi k ON q.razmer = k.razmer AND q.balon_turi = k.balon_turi
    LEFT JOIN last_sotish s ON q.razmer = s.razmer AND q.balon_turi = s.balon_turi
    WHERE q.q > 0
    ORDER BY q.balon_turi, q.razmer
  `;
  return rows;
}

/**
 * Sklad tannarx (investitsiya) va kutilayotgan sof foyda — bitta so'rov.
 */
async function getSkladValuationByTannarx(shopId = 1) {
  const r = await prisma.$queryRaw`
    WITH agg AS (
      SELECT t.size AS razmer, t.brand AS balon_turi, COALESCE(SUM(t.quantity), 0)::int AS kirdi, ROUND(AVG(t.price_buy))::int AS tan_narx
      FROM tires t WHERE (t.shop_id IS NULL OR t.shop_id = ${shopId}) GROUP BY t.size, t.brand
    ),
    outgo AS (
      SELECT t.size AS razmer, t.brand AS balon_turi, COALESCE(SUM(s.quantity), 0)::int AS sotildi
      FROM sales s INNER JOIN tires t ON s.tire_id = t.id
      WHERE s.item_type = 'NEW' AND (s.shop_id IS NULL OR s.shop_id = ${shopId}) GROUP BY t.size, t.brand
    ),
    qoldiq AS (
      SELECT a.razmer, a.balon_turi, GREATEST(0, a.kirdi - COALESCE(o.sotildi, 0))::int AS q, a.tan_narx
      FROM agg a LEFT JOIN outgo o ON a.razmer = o.razmer AND a.balon_turi = o.balon_turi
    ),
    last_sotish AS (
      SELECT DISTINCT ON (size, brand) size AS razmer, brand AS balon_turi, price_sell AS sotish_narx
      FROM tires WHERE (shop_id IS NULL OR shop_id = ${shopId}) ORDER BY size, brand, id DESC
    )
    SELECT
      COALESCE(SUM(q.q * q.tan_narx), 0)::bigint AS investitsiya,
      COALESCE(SUM(q.q * (COALESCE(s.sotish_narx, 0) - q.tan_narx)), 0)::bigint AS kutilayotgan
    FROM qoldiq q
    LEFT JOIN last_sotish s ON q.razmer = s.razmer AND q.balon_turi = s.balon_turi
    WHERE q.q > 0
  `;
  const row = r[0];
  return {
    investitsiya: Number(row?.investitsiya ?? 0),
    kutilayotganFoyda: Number(row?.kutilayotgan ?? 0),
  };
}

/**
 * Qoldiq 4 tadan kam bo'lgan pozitsiyalarni olinish_kerak ga qo'shish; sizes jadvalidagi 0 qoldiqlilarni ham.
 */
async function syncOlinishKerakFromStock(shopId = 1) {
  const lowStock = await prisma.$queryRaw`
    WITH agg AS (
      SELECT t.size AS razmer, t.brand AS balon_turi, COALESCE(SUM(t.quantity), 0)::int AS kirdi
      FROM tires t WHERE (t.shop_id IS NULL OR t.shop_id = ${shopId}) GROUP BY t.size, t.brand
    ),
    outgo AS (
      SELECT t.size AS razmer, t.brand AS balon_turi, COALESCE(SUM(s.quantity), 0)::int AS sotildi
      FROM sales s INNER JOIN tires t ON s.tire_id = t.id
      WHERE s.item_type = 'NEW' AND (s.shop_id IS NULL OR s.shop_id = ${shopId}) GROUP BY t.size, t.brand
    ),
    qoldiq AS (
      SELECT a.razmer, a.balon_turi, GREATEST(0, a.kirdi - COALESCE(o.sotildi, 0))::int AS q
      FROM agg a LEFT JOIN outgo o ON a.razmer = o.razmer AND a.balon_turi = o.balon_turi
    ),
    mavjud AS (
      SELECT razmer, balon_turi FROM olinish_kerak WHERE (shop_id IS NULL OR shop_id = ${shopId})
    )
    SELECT q.razmer, q.balon_turi, q.q FROM qoldiq q
    LEFT JOIN mavjud m ON q.razmer = m.razmer AND q.balon_turi = m.balon_turi
    WHERE q.q < 4 AND m.razmer IS NULL
  `;
  for (const row of lowStock) {
    const need = Math.max(1, 4 - row.q);
    await prisma.olinishKerak.create({
      data: { razmer: row.razmer, balonTuri: row.balon_turi, soni: need, shopId },
    }).catch(() => {});
  }
  const sizesZero = await prisma.$queryRaw`
    WITH agg AS (
      SELECT t.size AS razmer, t.brand AS balon_turi, COALESCE(SUM(t.quantity), 0)::int AS kirdi
      FROM tires t WHERE (t.shop_id IS NULL OR t.shop_id = ${shopId}) GROUP BY t.size, t.brand
    ),
    outgo AS (
      SELECT t.size AS razmer, t.brand AS balon_turi, COALESCE(SUM(s.quantity), 0)::int AS sotildi
      FROM sales s INNER JOIN tires t ON s.tire_id = t.id
      WHERE s.item_type = 'NEW' AND (s.shop_id IS NULL OR s.shop_id = ${shopId}) GROUP BY t.size, t.brand
    ),
    qoldiq AS (
      SELECT a.razmer, a.balon_turi, GREATEST(0, a.kirdi - COALESCE(o.sotildi, 0))::int AS q
      FROM agg a LEFT JOIN outgo o ON a.razmer = o.razmer AND a.balon_turi = o.balon_turi
    ),
    total_per_razmer AS (
      SELECT razmer, SUM(q)::int AS total FROM qoldiq GROUP BY razmer
    ),
    mavjud_placeholder AS (
      SELECT razmer FROM olinish_kerak WHERE (shop_id IS NULL OR shop_id = ${shopId}) AND balon_turi = '—'
    )
    SELECT s.name FROM sizes s
    LEFT JOIN total_per_razmer t ON s.name = t.razmer
    LEFT JOIN mavjud_placeholder m ON s.name = m.razmer
    WHERE (t.total IS NULL OR t.total = 0) AND m.razmer IS NULL
  `;
  for (const row of sizesZero) {
    await prisma.olinishKerak.create({
      data: { razmer: row.name, balonTuri: '—', soni: 1, shopId },
    }).catch(() => {});
  }
}

/**
 * Rabochiy balonlar ombori: jami dona va summa (soni * narx).
 */
async function getRabochiyOmborValue(shopId = 1) {
  const sid = shopId ?? DEFAULT_SHOP_ID;
  const r = await prisma.rabochiyBalon.aggregate({
    where: {
      soni: { gt: 0 },
      shopId: sid,
    },
    _sum: { soni: true },
    _count: true,
  });
  const sumRows = await prisma.rabochiyBalon.findMany({
    where: {
      soni: { gt: 0 },
      shopId: sid,
    },
    select: { soni: true, narx: true },
  });
  const summa = sumRows.reduce((s, x) => s + x.soni * x.narx, 0);
  const soni = sumRows.reduce((s, x) => s + x.soni, 0);
  return { soni, summa };
}

module.exports = {
  getNewTireBalance,
  getUsedTireBalance,
  getRabochiyBalonBalance,
  getFullInventorySummary,
  addKirimBatch,
  getKelganNarx,
  getSizesWithStock,
  getBrandsWithStock,
  getSkladRowsWithValuation,
  getSkladValuationByTannarx,
  syncOlinishKerakFromStock,
  getRabochiyOmborValue,
};
