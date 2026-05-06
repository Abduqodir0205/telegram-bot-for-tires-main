/**
 * Legacy jadvallar (kirim, chiqim, rabochiy_balon, sizes, brands, olinish_kerak) uchun
 * barcha o'qish/yozish — faqat Prisma orqali. index.js pool.query o'rniga shu servis.
 */
const { prisma } = require('../utils/database');

const DEFAULT_SHOP_ID = 1;

function shopWhere(shopId) {
  return { shopId: shopId ?? DEFAULT_SHOP_ID };
}

// Kirim modeli bazada "tires" jadvaliga map qilingan: brand, size, priceBuy, priceSell, quantity
function mapKirimRow(r) {
  const priceSell = Number(r.priceSell ?? 0);
  const quantity = Number(r.quantity ?? 0);
  return {
    id: r.id,
    razmer: r.size,
    balon_turi: r.brand,
    soni: quantity,
    kelgan_narx: Math.round(Number(r.priceBuy ?? 0)),
    sotish_narx: Math.round(priceSell),
    dollar_kurs: null,
    umumiy_qiymat: Math.round(quantity * priceSell),
    sana: r.createdAt,
  };
}

// Chiqim modeli bazada "sales" jadvaliga map qilingan; razmer/balon_turi kirim yoki usedTire orqali
function mapChiqimRowFromSale(r) {
  const razmer = r.kirim?.size ?? r.usedTire?.size ?? '';
  const balon_turi = r.kirim?.brand ?? (r.usedTire ? 'Ishchi' : '');
  return {
    id: r.id,
    razmer,
    balon_turi,
    sotildi: r.quantity,
    umumiy_qiymat: Math.round(Number(r.totalPrice ?? 0)),
    foyda: 0,
    naqd_foyda: null,
    zaxira_foyda: null,
    rabochiy_olindi: 0,
    rabochiy_narxi: 0,
    sana: r.createdAt,
  };
}

async function getSizes() {
  return prisma.size.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true } });
}

async function getBrands() {
  return prisma.brand.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true } });
}

async function getKirimCount(shopId) {
  return prisma.kirim.count({ where: shopWhere(shopId) });
}

async function getKirimPaginated(shopId, limit, offset) {
  const rows = await prisma.kirim.findMany({
    where: shopWhere(shopId),
    orderBy: { id: 'desc' },
    take: limit,
    skip: offset,
  });
  return rows.map(mapKirimRow);
}

async function getChiqimCount(shopId) {
  return prisma.chiqim.count({ where: shopWhere(shopId) });
}

async function getChiqimPaginated(shopId, limit, offset) {
  const rows = await prisma.chiqim.findMany({
    where: shopWhere(shopId),
    orderBy: { id: 'desc' },
    take: limit,
    skip: offset,
    include: { kirim: true, usedTire: true },
  });
  return rows.map(mapChiqimRowFromSale);
}

async function getKirimGroupedForReport(shopId) {
  const rows = await prisma.kirim.groupBy({
    by: ['size', 'brand'],
    where: shopWhere(shopId),
    _sum: { quantity: true },
    _avg: { priceBuy: true },
  });
  return rows.map((r) => ({
    razmer: r.size,
    balon_turi: r.brand,
    kirdi: Number(r._sum.quantity || 0),
    tan_narxi: Math.round(Number(r._avg.priceBuy || 0)),
  }));
}

async function getChiqimSumsForRazmerBrand(razmer, balon_turi, shopId) {
  const kirimRows = await prisma.kirim.findMany({
    where: { ...shopWhere(shopId), size: razmer, brand: balon_turi },
    select: { id: true },
  });
  const tireIds = kirimRows.map((k) => k.id);
  if (tireIds.length === 0) return { sotildi: 0, foyda: 0 };
  const r = await prisma.chiqim.aggregate({
    where: { tireId: { in: tireIds } },
    _sum: { quantity: true, totalPrice: true },
  });
  return {
    sotildi: Number(r._sum.quantity || 0),
    foyda: Number(r._sum.totalPrice || 0),
  };
}

function mapChiqimRow(r) {
  return mapChiqimRowFromSale(r);
}

async function getChiqimByDateRange(shopId, startDate, endDate) {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  const rows = await prisma.chiqim.findMany({
    where: { ...shopWhere(shopId), createdAt: { gte: start, lte: end } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { kirim: true, usedTire: true },
  });
  return rows.map(mapChiqimRowFromSale);
}

async function getChiqimByDate(shopId, date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  const rows = await prisma.chiqim.findMany({
    where: { ...shopWhere(shopId), createdAt: { gte: start, lte: end } },
    orderBy: { id: 'desc' },
    include: { kirim: true, usedTire: true },
  });
  return rows.map(mapChiqimRowFromSale);
}

async function getKirimByDateRange(shopId, startDate, endDate) {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  const rows = await prisma.kirim.findMany({
    where: { ...shopWhere(shopId), createdAt: { gte: start, lte: end } },
    orderBy: [{ brand: 'asc' }, { size: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map((r) => ({
    ...mapKirimRow(r),
    narx_dona: Math.round(Number(r.priceBuy ?? 0)),
  }));
}

async function getRabochiySotuvByDate(shopId, date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  const rows = await prisma.rabochiySotuv.findMany({
    where: { ...shopWhere(shopId), sana: { gte: start, lte: end } },
    orderBy: { id: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    sotilgan_narx: r.sotilganNarx,
    olingan_narx: r.olinganNarx,
    sana: r.sana,
  }));
}

async function getRabochiyBalonList(shopId, orderByRazmer = true) {
  const rows = await prisma.rabochiyBalon.findMany({
    where: { ...shopWhere(shopId), soni: { gt: 0 } },
    orderBy: orderByRazmer ? [{ razmer: 'asc' }] : [{ id: 'desc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    razmer: r.razmer,
    balon_turi: r.balonTuri,
    soni: r.soni,
    narx: r.narx,
    holat: r.holat,
    sana: r.sana,
  }));
}

async function getRabochiyBalonByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const rows = await prisma.rabochiyBalon.findMany({
    where: { id: { in: ids }, soni: { gt: 0 } },
  });
  return rows.map((r) => ({
    id: r.id,
    razmer: r.razmer,
    balon_turi: r.balonTuri,
    narx: r.narx,
  }));
}

async function getRabochiyBalonPaginated(shopId, limit, offset) {
  const rows = await prisma.rabochiyBalon.findMany({
    where: shopWhere(shopId),
    orderBy: { id: 'desc' },
    take: limit,
    skip: offset,
  });
  return rows.map((r) => ({
    id: r.id,
    razmer: r.razmer,
    balon_turi: r.balonTuri,
    soni: r.soni,
    narx: r.narx,
    holat: r.holat,
    sana: r.sana,
  }));
}

async function getRabochiySotuvPaginated(shopId, limit, offset) {
  const rows = await prisma.rabochiySotuv.findMany({
    where: shopWhere(shopId),
    orderBy: { id: 'desc' },
    take: limit,
    skip: offset,
  });
  return rows.map((r) => ({
    id: r.id,
    razmer: r.razmer,
    balon_turi: r.balonTuri,
    olingan_narx: r.olinganNarx,
    sotilgan_narx: r.sotilganNarx,
    sana: r.sana,
  }));
}

async function getOlinishKerakList(shopId) {
  const rows = await prisma.olinishKerak.findMany({
    where: shopWhere(shopId),
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    razmer: r.razmer,
    balon_turi: r.balonTuri,
    soni: r.soni,
  }));
}

async function getChiqimSoldByRazmerBrandSince(shopId, sinceDate) {
  const start = new Date(sinceDate);
  start.setHours(0, 0, 0, 0);
  const rows = await prisma.chiqim.findMany({
    where: { ...shopWhere(shopId), createdAt: { gte: start }, itemType: 'NEW', tireId: { not: null } },
    include: { kirim: true },
  });
  const map = {};
  for (const r of rows) {
    if (r.kirim) {
      const key = `${r.kirim.size}|${r.kirim.brand}`;
      map[key] = (map[key] || 0) + r.quantity;
    }
  }
  return map;
}

async function getChiqimTotalsAggregate(shopId) {
  const r = await prisma.chiqim.aggregate({
    where: shopWhere(shopId),
    _sum: { totalPrice: true, quantity: true },
  });
  const sum = Number(r._sum.totalPrice || 0);
  const sotildi = Number(r._sum.quantity || 0);
  return {
    sum,
    foyda: sum,
    naqd_foyda: 0,
    zaxira_foyda: 0,
    sotildi,
  };
}

async function getKirimTotalsAggregate(shopId) {
  const rows = await prisma.kirim.findMany({
    where: shopWhere(shopId),
    select: { quantity: true, priceBuy: true, priceSell: true },
  });
  let soom_sum = 0;
  for (const r of rows) {
    soom_sum += Number(r.quantity ?? 0) * Number(r.priceBuy ?? 0);
  }
  return { dollar_sum: 0, soom_sum };
}

async function getRabochiyBalonCount(shopId) {
  const r = await prisma.rabochiyBalon.aggregate({
    where: { ...shopWhere(shopId) },
    _sum: { soni: true },
  });
  return Number(r._sum.soni || 0);
}

async function getRabochiyBalonRowCount(shopId) {
  return prisma.rabochiyBalon.count({ where: shopWhere(shopId) });
}

async function getRabochiySotuvCount(shopId) {
  return prisma.rabochiySotuv.count({ where: shopWhere(shopId) });
}

async function updateOlinishKerakSoni(id, soni) {
  return prisma.olinishKerak.update({
    where: { id },
    data: { soni },
  });
}

async function createOlinishKerak(razmer, balon_turi, soni, shopId) {
  return prisma.olinishKerak.create({
    data: { razmer, balonTuri: balon_turi, soni, shopId: shopId || null },
  });
}

async function getTableCount(table, shopId) {
  const sid = shopId ?? DEFAULT_SHOP_ID;
  const counts = {
    kirim: () => prisma.kirim.count({ where: { shopId: sid } }),
    chiqim: () => prisma.chiqim.count({ where: { shopId: sid } }),
    rabochiy_balon: () => prisma.rabochiyBalon.count({ where: { shopId: sid } }),
    rabochiy_sotuv: () => prisma.rabochiySotuv.count({ where: { shopId: sid } }),
    olinish_kerak: () => prisma.olinishKerak.count({ where: { shopId: sid } }),
    sizes: () => prisma.size.count(),
    brands: () => prisma.brand.count(),
  };
  const fn = counts[table];
  if (!fn) throw new Error('Unknown table');
  return fn();
}

const TABLE_TO_PHYSICAL_NAME = {
  kirim: 'tires',
  chiqim: 'sales',
  rabochiy_balon: 'rabochiy_balon',
  rabochiy_sotuv: 'rabochiy_sotuv',
  olinish_kerak: 'olinish_kerak',
  sizes: 'sizes',
  brands: 'brands',
};

/** Jadval bo'sh bo'lsa PostgreSQL sequence ni qaytaradi – keyingi id 1 dan boshlanadi */
async function resetTableSequenceIfEmpty(physicalTable) {
  const countResult = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM "${physicalTable}"`
  );
  const count = (countResult && countResult[0] && countResult[0].c) ? countResult[0].c : 0;
  if (count > 0) return;
  const seqName = `"${physicalTable}_id_seq"`;
  try {
    await prisma.$executeRawUnsafe(
      `SELECT setval((SELECT pg_get_serial_sequence($1, 'id')), 0)`,
      physicalTable
    );
  } catch (_) {
    try {
      await prisma.$executeRawUnsafe(`ALTER SEQUENCE ${seqName} RESTART WITH 1`);
    } catch (__) {}
  }
}

async function deleteAllFromTable(table, shopId) {
  const withShop = ['kirim', 'chiqim', 'rabochiy_balon', 'rabochiy_sotuv', 'olinish_kerak'];
  const sid = shopId ?? DEFAULT_SHOP_ID;
  const where = withShop.includes(table) ? { shopId: sid } : {};
  const models = {
    kirim: prisma.kirim,
    chiqim: prisma.chiqim,
    rabochiy_balon: prisma.rabochiyBalon,
    rabochiy_sotuv: prisma.rabochiySotuv,
    olinish_kerak: prisma.olinishKerak,
    sizes: prisma.size,
    brands: prisma.brand,
  };
  const model = models[table];
  if (!model) throw new Error('Unknown table');
  const result = await model.deleteMany({ where });
  const physicalTable = TABLE_TO_PHYSICAL_NAME[table];
  if (physicalTable) await resetTableSequenceIfEmpty(physicalTable);
  return result.count;
}

async function deleteById(table, id) {
  const tables = {
    kirim: prisma.kirim,
    chiqim: prisma.chiqim,
    rabochiy_balon: prisma.rabochiyBalon,
    rabochiy_sotuv: prisma.rabochiySotuv,
    olinish_kerak: prisma.olinishKerak,
    sizes: prisma.size,
    brands: prisma.brand,
  };
  const model = tables[table];
  if (!model) throw new Error('Unknown table');
  return model.delete({ where: { id } });
}

async function deleteRange(table, minId, maxId, shopId) {
  const tables = {
    kirim: prisma.kirim,
    chiqim: prisma.chiqim,
    rabochiy_balon: prisma.rabochiyBalon,
    rabochiy_sotuv: prisma.rabochiySotuv,
    olinish_kerak: prisma.olinishKerak,
    sizes: prisma.size,
    brands: prisma.brand,
  };
  const model = tables[table];
  if (!model) throw new Error('Unknown table');
  const where = { id: { gte: minId, lte: maxId } };
  if (!['sizes', 'brands'].includes(table)) where.shopId = shopId ?? DEFAULT_SHOP_ID;
  const result = await model.deleteMany({ where });
  return result;
}

async function updateKirimUmumiyQiymat(id) {
  // tires jadvalida umumiy_qiymat ustuni yo'q; no-op
}

const ALLOWED_UPDATE_COLUMNS = new Set([
  'name', 'soni', 'sotildi', 'umumiy_qiymat', 'foyda', 'naqd_foyda', 'zaxira_foyda',
  'rabochiy_olindi', 'rabochiy_narxi', 'kelgan_narx', 'sotish_narx', 'narx', 'sana',
  'razmer', 'balon_turi', 'holat', 'olingan_narx', 'sotilgan_narx',
]);

const TABLE_TO_PHYSICAL = { kirim: 'tires', chiqim: 'sales' };
const FIELD_TO_PHYSICAL = {
  kelgan_narx: 'price_buy', sotish_narx: 'price_sell', soni: 'quantity',
  razmer: 'size', balon_turi: 'brand', sana: 'created_at', quantity: 'quantity', total_price: 'total_price',
};

async function updateRow(table, id, field, value) {
  if (!ALLOWED_UPDATE_COLUMNS.has(field)) throw new Error('Disallowed field');
  const tables = ['kirim', 'chiqim', 'rabochiy_balon', 'rabochiy_sotuv', 'olinish_kerak', 'sizes', 'brands'];
  if (!tables.includes(table)) throw new Error('Unknown table');
  const physicalTable = TABLE_TO_PHYSICAL[table] || table;
  const physicalField = FIELD_TO_PHYSICAL[field] || field;
  const quoted = '"' + String(physicalField).replace(/"/g, '""') + '"';
  const result = await prisma.$executeRawUnsafe(
    `UPDATE ${physicalTable} SET ${quoted} = $1 WHERE id = $2`,
    value,
    id
  );
  return typeof result === 'number' ? result : 0;
}

async function ensureSize(name) {
  return prisma.size.upsert({ where: { name }, create: { name }, update: {} });
}

async function ensureBrand(name) {
  return prisma.brand.upsert({ where: { name }, create: { name }, update: {} });
}

async function createKirim(data) {
  const shopId = data.shop_id != null ? data.shop_id : 1;
  const size = data.razmer;
  const brand = data.balon_turi;
  const quantity = data.soni || 0;
  const priceBuy = Math.round(Number(data.kelgan_narx) || 0);
  const priceSell = Math.round(Number(data.sotish_narx) || priceBuy);
  return prisma.kirim.upsert({
    where: {
      shopId_brand_size: { shopId, brand, size },
    },
    create: { shopId, brand, size, quantity, priceBuy, priceSell },
    update: { quantity: { increment: quantity }, priceBuy, priceSell },
  });
}

async function getStock(razmer, balon_turi, shopId) {
  const kirimSum = await prisma.kirim.aggregate({
    where: { size: razmer, brand: balon_turi, ...shopWhere(shopId) },
    _sum: { quantity: true },
  });
  const kirimRows = await prisma.kirim.findMany({
    where: { size: razmer, brand: balon_turi, ...shopWhere(shopId) },
    select: { id: true },
  });
  const tireIds = kirimRows.map((k) => k.id);
  if (tireIds.length === 0) return 0;
  const chiqimSum = await prisma.chiqim.aggregate({
    where: { tireId: { in: tireIds } },
    _sum: { quantity: true },
  });
  const k = Number(kirimSum._sum.quantity || 0);
  const c = Number(chiqimSum._sum.quantity || 0);
  return Math.max(0, k - c);
}

async function getSotishNarx(razmer, balon_turi, shopId) {
  const row = await prisma.kirim.findFirst({
    where: { size: razmer, brand: balon_turi, ...shopWhere(shopId) },
    orderBy: { id: 'desc' },
    select: { priceSell: true },
  });
  if (!row) return 0;
  return { sotishNarx: Math.round(Number(row.priceSell || 0)), dollarKurs: null };
}

async function getDistinctRazmerWithStock(shopId = null) {
  const where = shopId != null ? shopWhere(shopId) : {};
  const rows = await prisma.kirim.findMany({
    where,
    select: { size: true, brand: true, quantity: true, id: true },
  });
  const byKey = {};
  for (const r of rows) {
    const key = `${r.size}|${r.brand}`;
    if (!byKey[key]) byKey[key] = { kirimIds: [], totalQty: 0 };
    byKey[key].kirimIds.push(r.id);
    byKey[key].totalQty += r.quantity || 0;
  }
  const sizesWithStock = new Set();
  for (const [key, v] of Object.entries(byKey)) {
    if (v.totalQty <= 0) continue;
    const sold = await prisma.chiqim.aggregate({
      where: { tireId: { in: v.kirimIds } },
      _sum: { quantity: true },
    });
    const soldQty = Number(sold._sum.quantity || 0);
    if (v.totalQty - soldQty > 0) sizesWithStock.add(key.split('|')[0]);
  }
  return [...sizesWithStock].sort();
}

module.exports = {
  getSizes,
  getBrands,
  getKirimCount,
  getKirimPaginated,
  getChiqimCount,
  getChiqimPaginated,
  getKirimGroupedForReport,
  getChiqimSumsForRazmerBrand,
  getChiqimByDate,
  getChiqimByDateRange,
  getKirimByDateRange,
  getRabochiySotuvByDate,
  getRabochiyBalonList,
  getRabochiyBalonByIds,
  getRabochiyBalonPaginated,
  getRabochiyBalonRowCount,
  getRabochiySotuvPaginated,
  getOlinishKerakList,
  getChiqimSoldByRazmerBrandSince,
  getChiqimTotalsAggregate,
  getKirimTotalsAggregate,
  getRabochiyBalonCount,
  getRabochiySotuvCount,
  updateOlinishKerakSoni,
  createOlinishKerak,
  getTableCount,
  deleteAllFromTable,
  deleteById,
  deleteRange,
  updateKirimUmumiyQiymat,
  updateRow,
  ensureSize,
  ensureBrand,
  createKirim,
  getStock,
  getSotishNarx,
  getDistinctRazmerWithStock,
};
