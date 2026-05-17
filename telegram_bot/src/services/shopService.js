/**
 * Shop Service: Do'konlar, sozlamalar, adminlar.
 * Barcha DB murojaatlari Prisma orqali.
 */
const { prisma } = require('../utils/database');

const BOSS_ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_IDS?.split(',')[0]) || 222592599;

function isBoss(telegramId) {
  return Number(telegramId) === BOSS_ADMIN_TELEGRAM_ID;
}

/**
 * Barcha do'konlar (id, name, ...).
 */
async function getShops() {
  return prisma.shop.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      name: true,
      location: true,
      phone: true,
      latitude: true,
      longitude: true,
      createdAt: true,
    },
  });
}

const DEFAULT_SHOP_ID = 1;

/**
 * Bitta do'kon ID bo'yicha. null/undefined yoki noto'g'ri id bo'lsa null qaytaradi.
 */
async function getShopById(shopId) {
  if (shopId == null || shopId === '') return null;
  const id = Number(shopId);
  if (Number.isNaN(id)) return null;
  return prisma.shop.findUnique({
    where: { id },
  });
}

/**
 * Do'kon sozlamasi: avval shop_settings, keyin settings (fallback).
 */
async function getSetting(key, shopId = 1) {
  const row = await prisma.shopSetting.findUnique({
    where: { shopId_key: { shopId, key } },
  });
  if (row?.value != null) return row.value;
  const fallback = await prisma.setting.findUnique({
    where: { key },
  });
  return fallback?.value ?? null;
}

/**
 * Do'kon sozlamasini saqlash (shop_settings).
 */
async function setSetting(key, value, shopId = 1) {
  await prisma.shopSetting.upsert({
    where: { shopId_key: { shopId, key } },
    create: { shopId, key, value: value != null ? String(value) : null },
    update: { value: value != null ? String(value) : null },
  });
}

/**
 * Dollar kursini o'zgartirish va tarixga yozish.
 */
async function setDollarKurs(newKurs, shopId = 1) {
  await setSetting('dollar_kurs', newKurs.toString(), shopId);
  await prisma.dollarHistory.create({
    data: { kurs: Number(newKurs), shopId },
  });
}

/**
 * Sanaga qarab kurs (dollar_history yoki sozlamadan).
 */
async function getKursByDate(date, shopId = 1) {
  const last = await prisma.dollarHistory.findFirst({
    where: { shopId, changedAt: { lte: date } },
    orderBy: { changedAt: 'desc' },
  });
  if (last) return Number(last.kurs);
  const kursStr = await getSetting('dollar_kurs', shopId);
  return parseInt(kursStr, 10) || 1;
}

/**
 * Admin bo'lgan do'konlar ID lari (boss = barcha do'konlar).
 */
async function getAdminShopIds(telegramId) {
  if (isBoss(telegramId)) {
    const rows = await prisma.shop.findMany({ orderBy: { id: 'asc' }, select: { id: true } });
    return rows.map((x) => x.id);
  }
  const rows = await prisma.shopAdmin.findMany({
    where: { telegramId: BigInt(telegramId) },
    orderBy: { shopId: 'asc' },
    select: { shopId: true },
  });
  return rows.map((x) => x.shopId);
}

/**
 * Hech bo'lmaganda bitta do'konda adminmi.
 */
async function isAdmin(telegramId) {
  if (isBoss(telegramId)) return true;
  const c = await prisma.shopAdmin.count({
    where: { telegramId: BigInt(telegramId) },
  });
  return c > 0;
}

/**
 * Barcha do'konlar + sozlamalar (address, phone, latitude, working_hours, shop_name).
 * User panel va "Yaqin do'konlar" uchun.
 */
async function getAllShopsWithSettings() {
  const shops = await prisma.shop.findMany({ orderBy: { id: 'asc' } });
  const list = [];
  for (const row of shops) {
    const shopId = row.id;
    const address = await getSetting('address', shopId);
    const phone = await getSetting('phone', shopId);
    const latStr = await getSetting('latitude', shopId);
    const lonStr = await getSetting('longitude', shopId);
    const workingHours = await getSetting('working_hours', shopId);
    const shopName = (await getSetting('shop_name', shopId)) || row.name;
    const lat = latStr ? parseFloat(latStr) : NaN;
    const lon = lonStr ? parseFloat(lonStr) : NaN;
    const isValid = (la, lo) =>
      !isNaN(la) && la >= -90 && la <= 90 && !isNaN(lo) && lo >= -180 && lo <= 180;
    list.push({
      id: shopId,
      name: row.name,
      shopName: shopName || row.name,
      address: address || '-',
      phone: phone || '-',
      workingHours: workingHours || '-',
      latitude: isValid(lat, lon) ? lat : null,
      longitude: isValid(lat, lon) ? lon : null,
    });
  }
  return list;
}

/**
 * User lokatsiyasiga qarab do'konlarni yaqinlik bo'yicha (haversine km).
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getShopsSortedByDistance(userLat, userLon) {
  const list = await getAllShopsWithSettings();
  const withLocation = [];
  const withoutLocation = [];
  const isValid = (la, lo) =>
    !isNaN(la) && la >= -90 && la <= 90 && !isNaN(lo) && lo >= -180 && lo <= 180;
  for (const s of list) {
    if (s.latitude != null && s.longitude != null) {
      const km = haversineKm(userLat, userLon, s.latitude, s.longitude);
      withLocation.push({ ...s, distanceKm: km });
    } else {
      withoutLocation.push({ ...s, distanceKm: null });
    }
  }
  withLocation.sort((a, b) => {
    const d = a.distanceKm - b.distanceKm;
    return d !== 0 ? d : (a.shopName || '').localeCompare(b.shopName || '');
  });
  return [...withLocation, ...withoutLocation];
}

/**
 * Do'kon adminlari (telegram_id) ro'yxati.
 */
async function getShopAdmins(shopId) {
  const rows = await prisma.shopAdmin.findMany({
    where: { shopId },
    select: { telegramId: true },
  });
  return rows.map((r) => r.telegramId.toString());
}

/**
 * shops_id_seq ni joriy max id ga moslash (keyingi INSERT lar uchun).
 */
async function setShopSequenceAfterId(lastId) {
  await prisma.$executeRaw`
    SELECT setval(
      pg_get_serial_sequence('public.shops', 'id'),
      ${lastId},
      true
    )
  `;
}

/**
 * Yangi do'kon qo'shish (boss).
 * Serial sequence bazadan orqada qolganda avtomatik id takrorlanib P2002 beradi;
 * shuning uchun id ni MAX(id)+1 qilib beramiz va sequence ni yangilaymiz.
 */
async function createShop(name) {
  const trimmed = (name || '').trim() || "Do'kon";
  const defaultsTemplate = (shop) => [
    ['shop_name', trimmed],
    ['phone', ''],
    ['address', ''],
    ['dollar_kurs', '12800'],
    ['report_daily_time', '21:00'],
    ['report_weekly_day', '5'],
  ];

  for (let attempt = 0; attempt < 5; attempt++) {
    const maxRow = await prisma.shop.aggregate({ _max: { id: true } });
    const nextId = (maxRow._max.id ?? 0) + 1;
    try {
      const shop = await prisma.shop.create({
        data: {
          id: nextId,
          name: trimmed,
          phone: null,
          location: null,
          latitude: null,
          longitude: null,
        },
      });
      try {
        await setShopSequenceAfterId(nextId);
      } catch {
        // sequence nomi topilmasa ham yozuv yaratilgan
      }
      const defaults = defaultsTemplate(shop);
      for (const [k, v] of defaults) {
        await setSetting(k, v, shop.id);
      }
      return shop;
    } catch (e) {
      if (e?.code === 'P2002' && attempt < 4) continue;
      throw e;
    }
  }
  throw new Error("createShop: takroriy urinishlar yetarli emas");
}

/**
 * Shop adminga admin qo'shish (telegram_id + shop_id).
 */
async function addShopAdmin(telegramId, shopId) {
  await prisma.shopAdmin.upsert({
    where: {
      telegramId_shopId: { telegramId: BigInt(telegramId), shopId },
    },
    create: { telegramId: BigInt(telegramId), shopId },
    update: {},
  });
}

/**
 * Do'kondan adminni olib tashlash.
 */
async function removeShopAdmin(shopId, telegramId) {
  await prisma.shopAdmin.deleteMany({
    where: { shopId, telegramId: BigInt(telegramId) },
  });
}

module.exports = {
  BOSS_ADMIN_TELEGRAM_ID,
  isBoss,
  getShops,
  getShopById,
  getSetting,
  setSetting,
  setDollarKurs,
  getKursByDate,
  getAdminShopIds,
  isAdmin,
  getAllShopsWithSettings,
  getShopsSortedByDistance,
  getShopAdmins,
  createShop,
  addShopAdmin,
  removeShopAdmin,
};
