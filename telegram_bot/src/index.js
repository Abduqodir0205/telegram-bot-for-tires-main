require("dotenv").config();

const https = require("https");
const { Bot, session, InlineKeyboard, Keyboard, InputFile } = require("grammy");
const { Pool } = require("pg");
const { extractTableFromImage } = require("./gemini-ocr.js");
const { extractTableFromImageTesseract } = require("./tesseract-ocr.js");
const ExcelJS = require("exceljs");
const cron = require("node-cron");
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== DATABASE SETUP ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

// Initialize database tables
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Razmerlar
      CREATE TABLE IF NOT EXISTS sizes (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL
      );

      -- Brendlar
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL
      );

      -- Kirim: kelgan narxi va sotish narxi bilan
      CREATE TABLE IF NOT EXISTS kirim (
        id SERIAL PRIMARY KEY,
        razmer VARCHAR(50) NOT NULL,
        balon_turi VARCHAR(100) NOT NULL,
        soni INTEGER NOT NULL,
        kelgan_narx INTEGER NOT NULL,
        sotish_narx INTEGER NOT NULL,
        umumiy_qiymat INTEGER NOT NULL,
        sana DATE DEFAULT CURRENT_DATE,
        dollar_kurs DECIMAL(10,2) DEFAULT 0,
        narx_dona INTEGER DEFAULT 0
      );

      -- Chiqim/Sotuvlar
      CREATE TABLE IF NOT EXISTS chiqim (
        id SERIAL PRIMARY KEY,
        razmer VARCHAR(50) NOT NULL,
        balon_turi VARCHAR(100) NOT NULL,
        sotildi INTEGER NOT NULL,
        umumiy_qiymat INTEGER NOT NULL,
        foyda INTEGER DEFAULT 0,
        sana DATE DEFAULT CURRENT_DATE,
        rabochiy_olindi INTEGER DEFAULT 0,
        rabochiy_narxi INTEGER DEFAULT 0
      );

      -- Rabochiy balonlar
      CREATE TABLE IF NOT EXISTS rabochiy_balon (
        id SERIAL PRIMARY KEY,
        razmer VARCHAR(50) NOT NULL,
        balon_turi VARCHAR(100) NOT NULL,
        soni INTEGER NOT NULL,
        narx INTEGER DEFAULT 0,
        holat VARCHAR(20) DEFAULT 'yaxshi',
        sana DATE DEFAULT CURRENT_DATE
      );

      -- Olinishi kerak
      CREATE TABLE IF NOT EXISTS olinish_kerak (
        id SERIAL PRIMARY KEY,
        razmer VARCHAR(50) NOT NULL,
        balon_turi VARCHAR(100) NOT NULL,
        soni INTEGER NOT NULL
      );

      -- Sozlamalar
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT
      );
    `);

    // Default razmerlar
    const sizes = [
      "175/70 R12", "165/70 R13", "175/70 R13", "185/70 R13",
      "185/65 R14", "185/70 R14", "205/70 R14",
      "195/60 R15", "195/65 R15", "205/65 R15",
      "205/60 R16", "215/60 R16"
    ];

    const brands = [
      "Imperati", "Cotechoo, Cho1", "Cotechoo, Cho2", "Zitto Ravon",
      "Sunfull", "Vagner", "Hifly All-turi", "Joyroad",
      "Risen Durable", "Colo Grelander", "Largo, Smartline", "Largo, Arduzza"
    ];

    for (const size of sizes) {
      await client.query("INSERT INTO sizes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [size]);
    }

    for (const brand of brands) {
      await client.query("INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [brand]);
    }

    // Default sozlamalar
    await client.query(`
      INSERT INTO settings (key, value) VALUES 
        ('shop_name', 'SherShina'),
        ('phone', '+998 90 123 45 67'),
        ('address', 'Toshkent shahri'),
        ('dollar_kurs', '12800'),
        ('latitude', '41.311081'),
        ('longitude', '69.240562'),
        ('working_hours', '09:00 - 20:00'),
        ('report_daily_time', '21:00'),
        ('report_weekly_day', '5')
      ON CONFLICT (key) DO NOTHING
    `);

    console.log("Database initialized");
  } finally {
    client.release();
  }
}

// Dollar kursi tarixini saqlash uchun jadval
async function ensureDollarHistoryTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS dollar_history (
    id SERIAL PRIMARY KEY,
    kurs INTEGER NOT NULL,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

// Chiqim jadvaliga naqd_foyda, zaxira_foyda qo'shish (migration)
async function ensureChiqimFoydaColumns() {
  for (const col of ["naqd_foyda", "zaxira_foyda"]) {
    try {
      await pool.query(`ALTER TABLE chiqim ADD COLUMN ${col} INTEGER DEFAULT 0`);
    } catch (e) {
      if (!e.message?.includes("already exists")) console.warn("Chiqim migration:", e.message);
    }
  }
}

// Rabochiy balon sotilganda yoziladigan jadval (korrektirovka)
async function ensureRabochiySotuvTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS rabochiy_sotuv (
    id SERIAL PRIMARY KEY,
    rabochiy_balon_id INTEGER,
    razmer VARCHAR(50) NOT NULL,
    balon_turi VARCHAR(100) NOT NULL,
    olingan_narx INTEGER NOT NULL,
    sotilgan_narx INTEGER NOT NULL,
    sana DATE DEFAULT CURRENT_DATE
  )`);
}

// ==================== KO'P DO'KON: shops, shop_admins, shop_id migratsiya ====================
const BOSS_ADMIN_TELEGRAM_ID = 222592599;

async function ensureShopsAndAdmins() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      phone TEXT,
      address TEXT,
      dollar_kurs VARCHAR(20),
      report_daily_time VARCHAR(10) DEFAULT '21:00',
      report_weekly_day VARCHAR(2) DEFAULT '5',
      latitude VARCHAR(20),
      longitude VARCHAR(20),
      working_hours VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_admins (
      telegram_id BIGINT NOT NULL,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      PRIMARY KEY (telegram_id, shop_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_settings (
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      key VARCHAR(50) NOT NULL,
      value TEXT,
      PRIMARY KEY (shop_id, key)
    )
  `);
  for (const tbl of ["kirim", "chiqim", "rabochiy_balon", "olinish_kerak"]) {
    try {
      await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS shop_id INTEGER DEFAULT 1`);
    } catch (e) {
      if (!e.message?.includes("already exists")) console.warn("shop_id migration:", e.message);
    }
  }
  try {
    await pool.query(`ALTER TABLE rabochiy_sotuv ADD COLUMN IF NOT EXISTS shop_id INTEGER DEFAULT 1`);
  } catch (e) {
    if (!e.message?.includes("already exists")) console.warn("rabochiy_sotuv shop_id:", e.message);
  }
  try {
    await pool.query(`ALTER TABLE dollar_history ADD COLUMN IF NOT EXISTS shop_id INTEGER DEFAULT 1`);
  } catch (e) {
    if (!e.message?.includes("already exists")) console.warn("dollar_history shop_id:", e.message);
  }
  const hasShop1 = await pool.query("SELECT id FROM shops WHERE id = 1");
  if (hasShop1.rows.length === 0) {
    await pool.query(`
      INSERT INTO shops (id, name, phone, address, dollar_kurs, report_daily_time, report_weekly_day, latitude, longitude, working_hours)
      VALUES (1, 'SherShina', '+998 90 123 45 67', 'Toshkent shahri', '12800', '21:00', '5', '41.311081', '69.240562', '09:00 - 20:00')
    `);
    const defaults = [
      ["shop_name", "SherShina"], ["phone", "+998 90 123 45 67"], ["address", "Toshkent shahri"],
      ["dollar_kurs", "12800"], ["latitude", "41.311081"], ["longitude", "69.240562"],
      ["working_hours", "09:00 - 20:00"], ["report_daily_time", "21:00"], ["report_weekly_day", "5"]
    ];
    for (const [k, v] of defaults) {
      await pool.query(
        "INSERT INTO shop_settings (shop_id, key, value) VALUES (1, $1, $2) ON CONFLICT (shop_id, key) DO UPDATE SET value = $2",
        [k, v]
      );
    }
    const envAdmins = (process.env.ADMIN_IDS || "").split(",").map(id => parseInt(id.trim())).filter(Boolean);
    for (const tid of envAdmins) {
      try {
        await pool.query(
          "INSERT INTO shop_admins (telegram_id, shop_id) VALUES ($1, $2) ON CONFLICT (telegram_id, shop_id) DO NOTHING",
          [tid, 1]
        );
      } catch (e) { /* ignore */ }
    }
    await pool.query(
      "INSERT INTO shop_admins (telegram_id, shop_id) VALUES ($1, $2) ON CONFLICT (telegram_id, shop_id) DO NOTHING",
      [BOSS_ADMIN_TELEGRAM_ID, 1]
    );
    await pool.query("SELECT setval(pg_get_serial_sequence('shops', 'id'), (SELECT COALESCE(MAX(id), 1) FROM shops))").catch(() => {});
  } else {
    await pool.query("SELECT setval(pg_get_serial_sequence('shops', 'id'), (SELECT COALESCE(MAX(id), 1) FROM shops))").catch(() => {});
  }
}

// Indekslar — so'rovlar tezroq ishlashi uchun
async function ensureIndexes() {
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_kirim_shop_razmer_brend ON kirim (shop_id, razmer, balon_turi)",
    "CREATE INDEX IF NOT EXISTS idx_kirim_shop_id ON kirim (shop_id)",
    "CREATE INDEX IF NOT EXISTS idx_chiqim_shop_razmer_brend ON chiqim (shop_id, razmer, balon_turi)",
    "CREATE INDEX IF NOT EXISTS idx_chiqim_shop_id ON chiqim (shop_id)",
    "CREATE INDEX IF NOT EXISTS idx_chiqim_sana ON chiqim (sana)",
    "CREATE INDEX IF NOT EXISTS idx_kirim_sana ON kirim (sana)",
    "CREATE INDEX IF NOT EXISTS idx_rabochiy_balon_shop ON rabochiy_balon (shop_id)",
    "CREATE INDEX IF NOT EXISTS idx_rabochiy_sotuv_shop_sana ON rabochiy_sotuv (shop_id, sana)",
    "CREATE INDEX IF NOT EXISTS idx_shop_settings_shop_key ON shop_settings (shop_id, key)",
    "CREATE INDEX IF NOT EXISTS idx_dollar_history_shop ON dollar_history (shop_id, changed_at DESC)"
  ];
  for (const sql of indexes) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (!e.message?.includes("already exists")) console.warn("Index:", e.message);
    }
  }
}

// Dollar kursini o'zgartirganda tarixga yozish (shop bo'yicha)
async function setDollarKurs(newKurs, shopId = 1) {
  await setSetting("dollar_kurs", newKurs.toString(), shopId);
  await pool.query("INSERT INTO dollar_history (kurs, shop_id) VALUES ($1, $2)", [newKurs, shopId]);
}

// Kirim va chiqimda kursni olish uchun
async function getKursByDate(date, shopId = 1) {
  const res = await pool.query(
    `SELECT kurs FROM dollar_history WHERE shop_id = $1 AND changed_at <= $2 ORDER BY changed_at DESC LIMIT 1`,
    [shopId, date]
  );
  return Number(res.rows[0]?.kurs || await getSetting("dollar_kurs", shopId));
}

// ==================== HELPER FUNCTIONS ====================
async function getSetting(key, shopId = 1) {
  const result = await pool.query("SELECT value FROM shop_settings WHERE shop_id = $1 AND key = $2", [shopId, key]);
  if (result.rows[0]?.value != null) return result.rows[0].value;
  const fallback = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return fallback.rows[0]?.value || null;
}

async function setSetting(key, value, shopId = 1) {
  await pool.query(
    "INSERT INTO shop_settings (shop_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (shop_id, key) DO UPDATE SET value = $3",
    [shopId, key, value]
  );
}

function isBoss(telegramId) {
  return Number(telegramId) === BOSS_ADMIN_TELEGRAM_ID;
}

async function getAdminShopIds(telegramId) {
  if (isBoss(telegramId)) {
    const r = await pool.query("SELECT id FROM shops ORDER BY id");
    return r.rows.map((x) => x.id);
  }
  const r = await pool.query("SELECT shop_id FROM shop_admins WHERE telegram_id = $1 ORDER BY shop_id", [telegramId]);
  return r.rows.map((x) => x.shop_id);
}

async function isAdmin(telegramId) {
  if (isBoss(telegramId)) return true;
  const r = await pool.query("SELECT 1 FROM shop_admins WHERE telegram_id = $1 LIMIT 1", [telegramId]);
  return r.rows.length > 0;
}

function getCurrentShopId(ctx) {
  return ctx.session?.shopId != null ? ctx.session.shopId : 1;
}

/** Foydalanuvchi turi bo'yicha bosh menyu (user / admin / boss) */
async function getMainMenu(ctx) {
  if (ctx.from && (await isAdmin(ctx.from.id))) return isBoss(ctx.from.id) ? bossMenu : adminMenu;
  return userMenu;
}

async function getAllSizes() {
  const result = await pool.query("SELECT name FROM sizes ORDER BY id");
  return result.rows.map(r => r.name);
}

async function getAllBrands() {
  const result = await pool.query("SELECT name FROM brands ORDER BY id");
  return result.rows.map(r => r.name);
}

async function getStock(razmer, balon_turi, shopId = 1) {
  const r = await pool.query(
    `SELECT (SELECT COALESCE(SUM(soni), 0) FROM kirim WHERE razmer = $1 AND balon_turi = $2 AND (shop_id IS NULL OR shop_id = $3)) -
            (SELECT COALESCE(SUM(sotildi), 0) FROM chiqim WHERE razmer = $1 AND balon_turi = $2 AND (shop_id IS NULL OR shop_id = $3)) AS qoldiq`,
    [razmer, balon_turi, shopId]
  );
  return Number(r.rows[0]?.qoldiq ?? 0);
}

async function getSotishNarx(razmer, balon_turi, shopId = 1) {
  const result = await pool.query(
    "SELECT sotish_narx, dollar_kurs FROM kirim WHERE razmer = $1 AND balon_turi = $2 AND (shop_id IS NULL OR shop_id = $3) ORDER BY id DESC LIMIT 1",
    [razmer, balon_turi, shopId]
  );
  const row = result.rows[0];
  if (!row) return 0;
  const kurs = parseInt(await getSetting("dollar_kurs", shopId), 10) || 1;
  return row.dollar_kurs === 1 ? Math.round(Number(row.sotish_narx) * kurs) : Number(row.sotish_narx);
}

// O'rtacha tannarx (kelgan_narx) — sklad qiymati va foyda hisoblashning markaziy funksiyasi (so'mda)
async function getKelganNarx(razmer, balon_turi, shopId = 1) {
  const result = await pool.query(
    "SELECT kelgan_narx, dollar_kurs FROM kirim WHERE razmer = $1 AND balon_turi = $2 AND (shop_id IS NULL OR shop_id = $3)",
    [razmer, balon_turi, shopId]
  );
  if (!result.rows.length) return 0;
  const kurs = parseInt(await getSetting("dollar_kurs", shopId), 10) || 1;
  let sum = 0;
  let count = 0;
  for (const r of result.rows) {
    const val = r.dollar_kurs === 1 ? Number(r.kelgan_narx) * kurs : Number(r.kelgan_narx);
    sum += val;
    count++;
  }
  return count ? Math.round(sum / count) : 0;
}

// Skladda bor razmerlar (qoldiq > 0)
async function getSizesWithStock(shopId = 1) {
  const result = await pool.query(`
    SELECT DISTINCT k.razmer FROM kirim k
    WHERE (k.shop_id IS NULL OR k.shop_id = $1) AND
    (SELECT COALESCE(SUM(soni), 0) FROM kirim WHERE razmer = k.razmer AND balon_turi = k.balon_turi AND (shop_id IS NULL OR shop_id = $1)) -
    (SELECT COALESCE(SUM(sotildi), 0) FROM chiqim WHERE razmer = k.razmer AND balon_turi = k.balon_turi AND (shop_id IS NULL OR shop_id = $1)) > 0
    ORDER BY k.razmer
  `, [shopId]);
  return result.rows.map(r => r.razmer);
}

// Berilgan razmer uchun skladda bor brendlar
async function getBrandsWithStock(razmer, shopId = 1) {
  const result = await pool.query(`
    SELECT DISTINCT k.balon_turi FROM kirim k
    WHERE k.razmer = $1 AND (k.shop_id IS NULL OR k.shop_id = $2) AND
      (SELECT COALESCE(SUM(soni), 0) FROM kirim WHERE razmer = k.razmer AND balon_turi = k.balon_turi AND (shop_id IS NULL OR shop_id = $2)) -
      (SELECT COALESCE(SUM(sotildi), 0) FROM chiqim WHERE razmer = k.razmer AND balon_turi = k.balon_turi AND (shop_id IS NULL OR shop_id = $2)) > 0
    ORDER BY k.balon_turi
  `, [razmer, shopId]);
  return result.rows.map(r => r.balon_turi);
}

// Sklad tannarx (investitsiya) va kutilayotgan sof foyda — bitta SQL (N+1 yo'q)
async function getSkladValuationByTannarx(shopId = 1) {
  const r = await pool.query(`
    WITH agg AS (
      SELECT k.razmer, k.balon_turi, COALESCE(SUM(k.soni), 0) AS kirdi, ROUND(AVG(k.kelgan_narx))::int AS tan_narx
      FROM kirim k WHERE (k.shop_id IS NULL OR k.shop_id = $1) GROUP BY k.razmer, k.balon_turi
    ),
    outgo AS (
      SELECT razmer, balon_turi, COALESCE(SUM(sotildi), 0) AS sotildi
      FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1) GROUP BY razmer, balon_turi
    ),
    qoldiq AS (
      SELECT a.razmer, a.balon_turi, GREATEST(0, a.kirdi - COALESCE(o.sotildi, 0))::int AS q, a.tan_narx
      FROM agg a LEFT JOIN outgo o ON a.razmer = o.razmer AND a.balon_turi = o.balon_turi
    ),
    last_sotish AS (
      SELECT DISTINCT ON (razmer, balon_turi) razmer, balon_turi, sotish_narx
      FROM kirim WHERE (shop_id IS NULL OR shop_id = $1) ORDER BY razmer, balon_turi, id DESC
    )
    SELECT
      COALESCE(SUM(q.q * q.tan_narx), 0)::bigint AS investitsiya,
      COALESCE(SUM(q.q * (COALESCE(s.sotish_narx, 0) - q.tan_narx)), 0)::bigint AS kutilayotgan
    FROM qoldiq q
    LEFT JOIN last_sotish s ON q.razmer = s.razmer AND q.balon_turi = s.balon_turi
    WHERE q.q > 0
  `, [shopId]);
  return {
    investitsiya: Number(r.rows[0]?.investitsiya ?? 0),
    kutilayotganFoyda: Number(r.rows[0]?.kutilayotgan ?? 0)
  };
}

// Qoldiq hisoboti uchun barcha pozitsiyalar (bitta so'rov — tsikl emas)
async function getSkladRowsWithValuation(shopId = 1) {
  const r = await pool.query(`
    WITH agg AS (
      SELECT k.razmer, k.balon_turi, COALESCE(SUM(k.soni), 0) AS kirdi, ROUND(AVG(k.kelgan_narx))::int AS tan_narx
      FROM kirim k WHERE (k.shop_id IS NULL OR k.shop_id = $1) GROUP BY k.razmer, k.balon_turi
    ),
    outgo AS (
      SELECT razmer, balon_turi, COALESCE(SUM(sotildi), 0) AS sotildi
      FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1) GROUP BY razmer, balon_turi
    ),
    qoldiq AS (
      SELECT a.razmer, a.balon_turi, GREATEST(0, a.kirdi - COALESCE(o.sotildi, 0))::int AS q, a.tan_narx
      FROM agg a LEFT JOIN outgo o ON a.razmer = o.razmer AND a.balon_turi = o.balon_turi
    ),
    last_sotish AS (
      SELECT DISTINCT ON (razmer, balon_turi) razmer, balon_turi, sotish_narx
      FROM kirim WHERE (shop_id IS NULL OR shop_id = $1) ORDER BY razmer, balon_turi, id DESC
    ),
    with_kirdi AS (SELECT a.razmer, a.balon_turi, a.kirdi FROM agg a)
    SELECT q.razmer, q.balon_turi, k.kirdi, (k.kirdi - q.q) AS sotildi, q.q AS qoldiq, q.tan_narx, COALESCE(s.sotish_narx, 0) AS sotish_narx
    FROM qoldiq q
    JOIN with_kirdi k ON q.razmer = k.razmer AND q.balon_turi = k.balon_turi
    LEFT JOIN last_sotish s ON q.razmer = s.razmer AND q.balon_turi = s.balon_turi
    WHERE q.q > 0
    ORDER BY q.razmer, q.balon_turi
  `, [shopId]);
  return r.rows;
}

function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// Summani yaxlitlash: 488000 -> 500000, 420000/430000 -> 450000 (50 mingga yuqoriga)
function yaxlitla(som) {
  const s = Number(som) || 0;
  if (s <= 0) return 0;
  if (s < 100000) return Math.round(s / 10000) * 10000;
  return Math.ceil(s / 50000) * 50000;
}

// Kirim saqlash: sotish narxini (son + tur) oladi, yaxlitlab bazaga yozadi va xabar yuboradi
async function saveKirimWithSotishNarx(ctx, sotishNum, sotishType) {
  const data = ctx.session.data || {};
  const razmer = data.razmer;
  const balon_turi = data.balon_turi;
  const soni = data.soni;
  const narx_type = data.narx_type;
  const kelgan_narx_input = data.kelgan_narx_input;
  if (!razmer || !balon_turi || soni == null) {
    await ctx.reply("❌ Sessiya tugadi. Qaytadan kirimni boshlang.", { reply_markup: adminMenu });
    ctx.session.step = null;
    ctx.session.data = {};
    return;
  }
  const shopId = getCurrentShopId(ctx);
  const kurs = parseInt(await getSetting("dollar_kurs", shopId)) || 1;
  const kelganSomXom = narx_type === "dollar" ? Math.round((kelgan_narx_input || 0) * kurs) : Math.round(kelgan_narx_input || 0);
  const sotishSomXom = sotishType === "dollar" ? Math.round(sotishNum * kurs) : Math.round(sotishNum);
  const kelganSom = kelganSomXom; // Tan narx yaxlitlanmaydi
  const sotishSom = yaxlitla(sotishSomXom);
  const umumiySom = soni * sotishSom;
  try {
    await pool.query(
      `INSERT INTO kirim (razmer, balon_turi, soni, kelgan_narx, sotish_narx, umumiy_qiymat, dollar_kurs, narx_dona, shop_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [razmer, balon_turi, soni, kelganSom, sotishSom, umumiySom, narx_type === "dollar" || sotishType === "dollar" ? kurs : 0, kelganSom, shopId]
    );
  } catch (e) {
    await ctx.reply("❌ Kirim saqlashda xatolik: " + e.message, { reply_markup: (await isAdmin(ctx.from.id)) && isBoss(ctx.from.id) ? bossMenu : adminMenu });
    ctx.session.step = null;
    ctx.session.data = {};
    return;
  }
  ctx.session.step = null;
  ctx.session.data = {};
  const tanDollar = (kelganSom / kurs).toFixed(1);
  const sotishXomStr = formatNumber(sotishSomXom);
  const sotishYaxlitStr = formatNumber(sotishSom);
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  await ctx.reply(
    `✅ <b>Kirim saqlandi!</b>\n\n` +
    `🛞 ${razmer} | ${balon_turi}\n` +
    `📥 ${soni} ta\n\n` +
    `💵 Tan narx: ${tanDollar} $ = <b>${formatNumber(kelganSom)} so'm</b>\n` +
    (sotishType === "dollar"
      ? `💰 Sotish narx: ${sotishNum} $ → ${sotishXomStr} so'm → <b>${sotishYaxlitStr} so'm</b> (yaxlitlangan)\n`
      : `💰 Sotish narx: ${formatNumber(sotishSomXom)} so'm → <b>${sotishYaxlitStr} so'm</b> (yaxlitlangan)\n`) +
    `📊 Jami: <b>${formatNumber(umumiySom)} so'm</b>`,
    { reply_markup: adminMenu, parse_mode: "HTML" }
  );
}

function formatDate(date = new Date()) {
  return new Date(date).toLocaleDateString("ru-RU");
}

// ==================== KEYBOARDS ====================
const adminMenu = new Keyboard()
  .text("📦 Kirim").text("💰 Chiqim").row()
  .text("📊 Xisobot").text("📋 Royxat").row()
  .text("🔄 Rabochiy").text("🛒 Olinish kerak").row()
  .text("🔍 Qidiruv").row()
  .text("⚙️ Sozlamalar")
  .resized();

const bossMenu = new Keyboard()
  .text("📦 Kirim").text("💰 Chiqim").row()
  .text("📊 Xisobot").text("📋 Royxat").row()
  .text("🔄 Rabochiy").text("🛒 Olinish kerak").row()
  .text("🔍 Qidiruv").row()
  .text("🏢 Do'konlar boshqaruvi").text("📂 Do'kon tanlash").row()
  .text("⚙️ Sozlamalar")
  .resized();

const userMenu = new Keyboard()
  .text("🛞 Yangi Balonlar").text("🔄 Rabochiy Balonlar").row()
  .text("🚗 Mashinam uchun razmer").row()
  .text("📍 Manzil").text("📞 Aloqa")
  .resized();

// Mashina modeli bo'yicha shina razmerlari ma'lumoti (userlar uchun)
const CAR_TIRE_INFO = {
  damas: {
    name: "Damas / Labo",
    text: `🛞 <b>Damas / Labo</b>

📐 <b>Zavod razmeri:</b> 155/80 R12 (C - yuk shinasi)
✅ <b>Ommabop razmerlar:</b> 165/70 R12, 165/80 R12
📏 <b>Maksimal xavfsiz razmer:</b> 175/70 R13 (Diskni 13 dyuymga almashtirish sharti bilan)
⚠️ <b>Tavsiya etilmaydi:</b> 175/80 R13 (Orqa kuzovga tegadi, dinamika yo'qoladi)`
  },
  matiz: {
    name: "Matiz",
    text: `🛞 <b>Matiz</b>

📐 <b>Zavod razmeri:</b> 145/70 R13
✅ <b>Ommabop razmerlar:</b> 155/65 R13, 155/70 R13
📏 <b>Maksimal xavfsiz razmer:</b> 165/65 R13
⚠️ <b>Tavsiya etilmaydi:</b> 175/70 R13 (Rul burilganda ichki himoyaga (podkrilnik) ishqalanadi)`
  },
  spark: {
    name: "Spark (M300)",
    text: `🛞 <b>Spark (M300)</b>

📐 <b>Zavod razmeri:</b> 155/70 R14
✅ <b>Ommabop razmerlar:</b> 165/70 R14, 185/60 R14
📏 <b>Maksimal xavfsiz razmer:</b> 185/65 R14 yoki 195/50 R15 (Disk almashtirilsa)
⚠️ <b>Tavsiya etilmaydi:</b> 185/70 R14 (Mashina balandlashadi, lekin manyovrda beqaror bo'ladi)`
  },
  nexia12: {
    name: "Nexia 1 / Nexia 2",
    text: `🛞 <b>Nexia 1 / Nexia 2</b>

📐 <b>Zavod razmeri:</b> 175/70 R13 (N1) / 185/60 R14 (N2)
✅ <b>Ommabop razmerlar:</b> 185/65 R14, 185/70 R14 (Yumshoq yurishi uchun)
📏 <b>Maksimal xavfsiz razmer:</b> 195/60 R15 (Disk almashtirilsa)
⚠️ <b>Tavsiya etilmaydi:</b> 205/60 R15 (Podveska resursini kamaytiradi, rul og'irlashadi)`
  },
  nexia3: {
    name: "Nexia 3 (R3)",
    text: `🛞 <b>Nexia 3 (R3)</b>

📐 <b>Zavod razmeri:</b> 185/60 R15
✅ <b>Ommabop razmerlar:</b> 195/55 R15, 195/60 R15
📏 <b>Maksimal xavfsiz razmer:</b> 205/55 R15
⚠️ <b>Tavsiya etilmaydi:</b> 205/60 R15 (To'liq yuk bilan o'nqir-cho'nqirlarda kuzovga tegishi mumkin)`
  },
  cobalt: {
    name: "Cobalt",
    text: `🛞 <b>Cobalt</b>

📐 <b>Zavod razmeri:</b> 185/75 R14 (Po'lat disk) / 195/65 R15 (Quyma disk)
✅ <b>Ommabop razmerlar:</b> 205/65 R15, 205/60 R15
📏 <b>Maksimal xavfsiz razmer:</b> 205/70 R15 (Klirensni oshirish uchun)
⚠️ <b>Tavsiya etilmaydi:</b> 215/60 R16 (Rul mexanizmiga ortiqcha yuklama beradi)`
  },
  gentra: {
    name: "Gentra / Lacetti",
    text: `🛞 <b>Gentra / Lacetti</b>

📐 <b>Zavod razmeri:</b> 195/55 R15
✅ <b>Ommabop razmerlar:</b> 205/60 R15 (Eng ko'p qo'yiladigan yumshoq razmer)
📏 <b>Maksimal xavfsiz razmer:</b> 205/65 R15 yoki 215/50 R17 (Katta disk bilan)
⚠️ <b>Tavsiya etilmaydi:</b> 215/60 R15 (Spidometrda katta xatolik beradi va shina og'irlik qiladi)`
  },
  tracker: {
    name: "Tracker (1 & 2)",
    text: `🛞 <b>Tracker (1 & 2)</b>

📐 <b>Zavod razmeri:</b> 205/70 R16 yoki 215/55 R18
✅ <b>Ommabop razmerlar:</b> 215/60 R17, 225/55 R18
📏 <b>Maksimal xavfsiz razmer:</b> 225/60 R18
⚠️ <b>Tavsiya etilmaydi:</b> 235/55 R18 (Rul burilganda arka ichiga tegish ehtimoli yuqori)`
  },
  malibu: {
    name: "Malibu (1 & 2)",
    text: `🛞 <b>Malibu (1 & 2)</b>

📐 <b>Zavod razmeri:</b> 225/55 R17 / 245/45 R18 / 245/40 R19
✅ <b>Ommabop razmerlar:</b> 235/50 R18, 245/45 R18
📏 <b>Maksimal xavfsiz razmer:</b> 235/55 R18 (Yumshoqlik uchun)
⚠️ <b>Tavsiya etilmaydi:</b> 245/50 R19 (Faqat prujinalar almashtirilsa yoki "lift" qilinsa tushishi mumkin, aks holda ishqalanadi)`
  },
  tiko: {
    name: "Tiko",
    text: `🛞 <b>Tiko</b>

📐 <b>Zavod razmeri:</b> 135/80 R12
✅ <b>Ommabop razmerlar:</b> 145/70 R12, 155/65 R12
📏 <b>Maksimal xavfsiz razmer:</b> 155/70 R12
⚠️ <b>Tavsiya etilmaydi:</b> 165/70 R13 (Disk o'zgartirilsa ham, orqa arkalarga tegadi va rul mexanizmini tez ishdan chiqaradi)`
  },
  onix: {
    name: "Onix",
    text: `🛞 <b>Onix</b>

📐 <b>Zavod razmeri:</b> 185/65 R15 (Po'lat disk) / 195/55 R16 (Quyma disk)
✅ <b>Ommabop razmerlar:</b> 205/55 R16, 195/60 R16
📏 <b>Maksimal xavfsiz razmer:</b> 205/60 R16
⚠️ <b>Tavsiya etilmaydi:</b> 215/60 R16 (Rul to'liq burilganda ichki podkrilnikka tegadi)`
  },
  monza: {
    name: "Monza",
    text: `🛞 <b>Monza</b>

📐 <b>Zavod razmeri:</b> 205/55 R16
✅ <b>Ommabop razmerlar:</b> 205/60 R16, 215/55 R16
📏 <b>Maksimal xavfsiz razmer:</b> 215/60 R16 (Klirensni 1.5 sm ga ko'taradi)
⚠️ <b>Tavsiya etilmaydi:</b> 225/55 R17 (Faqat disk almashtirilganda, lekin podveska uchun og'irlik qiladi)`
  },
  epica: {
    name: "Epica",
    text: `🛞 <b>Epica</b>

📐 <b>Zavod razmeri:</b> 205/60 R16 / 215/50 R17
✅ <b>Ommabop razmerlar:</b> 215/60 R16, 225/50 R17
📏 <b>Maksimal xavfsiz razmer:</b> 215/65 R16 (Yumshoqlik uchun)
⚠️ <b>Tavsiya etilmaydi:</b> 235/45 R18 (Diskni o'ta ehtiyot qilish kerak bo'ladi, podveska qattiqlashadi)`
  },
  orlando: {
    name: "Orlando",
    text: `🛞 <b>Orlando</b>

📐 <b>Zavod razmeri:</b> 215/60 R16 / 225/50 R17
✅ <b>Ommabop razmerlar:</b> 215/65 R16, 225/55 R17
📏 <b>Maksimal xavfsiz razmer:</b> 225/60 R17
⚠️ <b>Tavsiya etilmaydi:</b> 235/45 R18 (Mashina og'irligi sababli disk tez pachoq bo'ladi)`
  },
  captiva: {
    name: "Captiva (1, 2, 3, 4)",
    text: `🛞 <b>Captiva (1, 2, 3, 4)</b>

📐 <b>Zavod razmeri:</b> 235/60 R17 / 235/55 R18 / 235/50 R19
✅ <b>Ommabop razmerlar:</b> 235/65 R17, 235/60 R18, 245/50 R19
📏 <b>Maksimal xavfsiz razmer:</b> 255/45 R19 yoki 235/65 R18
⚠️ <b>Tavsiya etilmaydi:</b> 255/55 R19 (Amortizator chashkasiga juda yaqin keladi yoki tegadi)`
  },
  kia5: {
    name: "Kia K5",
    text: `🛞 <b>Kia K5</b>

📐 <b>Zavod razmeri:</b> 215/55 R17 / 235/45 R18
✅ <b>Ommabop razmerlar:</b> 225/55 R17, 235/50 R18
📏 <b>Maksimal xavfsiz razmer:</b> 245/45 R18 yoki 245/40 R19 (Zavod varianti)
⚠️ <b>Tavsiya etilmaydi:</b> 235/55 R18 (Tezlikda manyovr qilishda barqarorlik kamayadi)`
  },
  changan: {
    name: "Changan (CS35/CS55)",
    text: `🛞 <b>Changan (CS35, CS55 va boshqa ommabop modellar)</b>

📐 <b>Zavod razmeri:</b> 215/50 R17 / 225/55 R18
✅ <b>Ommabop razmerlar:</b> 215/55 R17, 225/60 R18
📏 <b>Maksimal xavfsiz razmer:</b> 235/55 R18
⚠️ <b>Tavsiya etilmaydi:</b> 235/65 R17 (Arka ichida joy kamligi sababli ishqalanadi)`
  },
  jiguli: {
    name: "Jiguli (VAZ 2101-2107)",
    text: `🛞 <b>Jiguli (VAZ 2101-2107)</b>

📐 <b>Zavod razmeri:</b> 165/80 R13 (175/70 R13)
✅ <b>Ommabop razmerlar:</b> 185/65 R13, 185/60 R14 (Disk almashtirilsa)
📏 <b>Maksimal xavfsiz razmer:</b> 195/50 R15 (Disk almashtirilsa)
⚠️ <b>Tavsiya etilmaydi:</b> 205/60 R15 (Old g'ildiraklar burilganda kuzovga (lantjeron) tegadi)`
  }
};

const CAR_TIRE_WARNING = `\n\n⚠️ <b>DIQQAT:</b> Shina o'lchami zavod tavsiyasidan 3% dan ortiq farq qilsa, spidometr ko'rsatkichi o'zgaradi va tormoz tizimi (ABS) ishlashiga ta'sir qilishi mumkin.`;

const backBtn = new Keyboard().text("🔙 Ortga").resized();

async function sizeKeyboard(prefix = "size") {
  const sizes = await getAllSizes();
  const kb = new InlineKeyboard();
  for (let i = 0; i < sizes.length; i += 2) {
    if (sizes[i + 1]) {
      kb.text(sizes[i], `${prefix}_${sizes[i]}`).text(sizes[i + 1], `${prefix}_${sizes[i + 1]}`).row();
    } else {
      kb.text(sizes[i], `${prefix}_${sizes[i]}`).row();
    }
  }
  return kb;
}

async function brandKeyboard(prefix = "brand") {
  const brands = await getAllBrands();
  const kb = new InlineKeyboard();
  for (const brand of brands) {
    kb.text(brand, `${prefix}_${brand}`).row();
  }
  return kb;
}

// ==================== BOT SETUP ====================
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session({
  initial: () => ({ step: null, data: {} })
}));

bot.catch(err => console.error("Bot error:", err));

// ==================== START ====================
bot.command("start", async (ctx) => {
  const userId = ctx.from.id;
  const name = ctx.from.first_name;

  if (await isAdmin(userId)) {
    const shopIds = await getAdminShopIds(userId);
    if (ctx.session.shopId == null && shopIds.length > 0) ctx.session.shopId = shopIds[0];
    if (ctx.session.shopId == null) ctx.session.shopId = 1;
    const shopRow = await pool.query("SELECT id, name FROM shops WHERE id = $1", [ctx.session.shopId]);
    const shopName = shopRow.rows[0]?.name || "Do'kon";
    const menu = isBoss(userId) ? bossMenu : adminMenu;
    await ctx.reply(
      `🎉 Salom, ${name}!\n\n` +
      `📊 Admin paneliga xush kelibsiz!\n` +
      `📂 Joriy do'kon: <b>${shopName}</b>\n\n` +
      `Quyidagi tugmalar orqali boshqaring:`,
      { reply_markup: menu, parse_mode: "HTML" }
    );
  } else {
    const shopName = await getSetting("shop_name", 1);
    const workingHours = await getSetting("working_hours", 1);
    await ctx.reply(
      `🛞 <b>${shopName}</b> ga xush kelibsiz!\n\n` +
      `✨ Eng sifatli shinalar\n` +
      `💯 Kafolat bilan\n` +
      `🚗 Barcha avtomobillar uchun\n\n` +
      `🕐 Ish vaqti: ${workingHours}\n\n` +
      `👇 Quyidagi tugmalardan foydalaning:`,
      { reply_markup: userMenu, parse_mode: "HTML" }
    );
  }
});

bot.hears("🔙 Ortga", async (ctx) => {
  ctx.session.step = null;
  ctx.session.data = {};
  const isAd = await isAdmin(ctx.from.id);
  const kb = isAd ? (isBoss(ctx.from.id) ? bossMenu : adminMenu) : userMenu;
  await ctx.reply("Bosh menyu", { reply_markup: kb });
});

// ==================== USER PANEL ====================

// Qidiruv — faqat admin panelda (ichida Yangi va Eski tanlash)
bot.hears("🔍 Qidiruv", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;
  const kb = new InlineKeyboard()
    .text("🛞 Yangi balonlar", "qidiruv_yangi").row()
    .text("🔄 Eski (rabochiy) balonlar", "qidiruv_eski");
  await ctx.reply(
    "🔍 <b>Qidiruv</b>\n\nQanday balonlarni ko'rmoqchisiz?",
    { reply_markup: kb, parse_mode: "HTML" }
  );
});

bot.callbackQuery("qidiruv_yangi", async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await pool.query(`
    SELECT DISTINCT k.razmer 
    FROM kirim k 
    WHERE (SELECT COALESCE(SUM(soni), 0) FROM kirim WHERE razmer = k.razmer) - 
          (SELECT COALESCE(SUM(sotildi), 0) FROM chiqim WHERE razmer = k.razmer) > 0
    ORDER BY k.razmer
  `);
  if (result.rows.length === 0) {
    await ctx.reply(
      "😔 Hozircha yangi balonlar yo'q.",
      { reply_markup: await getMainMenu(ctx) }
    );
    return;
  }
  const kb = new InlineKeyboard();
  for (const r of result.rows) {
    kb.text(`🛞 ${r.razmer}`, `user_size_${r.razmer}`).row();
  }
  await ctx.reply(
    "🛞 <b>Yangi balonlar</b>\n\nRazmerni tanlang:\n\n💡 <i>Har bir razmerda turli brendlar mavjud</i>",
    { reply_markup: kb, parse_mode: "HTML" }
  );
});

bot.callbackQuery("qidiruv_eski", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = ctx.from && (await isAdmin(ctx.from.id)) ? getCurrentShopId(ctx) : 1;
  const result = await pool.query(
    "SELECT * FROM rabochiy_balon WHERE soni > 0 AND (shop_id IS NULL OR shop_id = $1) ORDER BY razmer",
    [shopId]
  );
  if (result.rows.length === 0) {
    await ctx.reply(
      "🔄 <b>Eski (rabochiy) balonlar</b>\n\n😔 Hozircha yo'q.",
      { reply_markup: await getMainMenu(ctx), parse_mode: "HTML" }
    );
    return;
  }
  let text = "🔄 <b>Eski (rabochiy) balonlar</b>\n";
  text += "━━━━━━━━━━━━━━━━━━\n\n";
  text += "💡 <i>Sifatli, arzon narxda!</i>\n\n";
  for (const r of result.rows) {
    const holat = r.holat === 'yaxshi' ? '✅ Yaxshi' : r.holat === 'orta' ? '🟡 O\'rta' : '🔴 Past';
    text += `🛞 <b>${r.razmer}</b> | ${r.balon_turi}\n`;
    text += `💵 ${formatNumber(r.narx)} so'm\n`;
    text += `📊 Holat: ${holat}\n\n`;
  }
  text += `━━━━━━━━━━━━━━━━━━\n`;
  await ctx.reply(text, { reply_markup: await getMainMenu(ctx), parse_mode: "HTML" });
});

// Yangi Balonlar - faqat mavjud razmerlar, sonisiz
bot.hears("🛞 Yangi Balonlar", async (ctx) => {
  // Mavjud razmerlarni olish (qoldig'i bor bo'lganlar)
  const result = await pool.query(`
    SELECT DISTINCT k.razmer 
    FROM kirim k 
    WHERE (SELECT COALESCE(SUM(soni), 0) FROM kirim WHERE razmer = k.razmer) - 
          (SELECT COALESCE(SUM(sotildi), 0) FROM chiqim WHERE razmer = k.razmer) > 0
    ORDER BY k.razmer
  `);

  if (result.rows.length === 0) {
    await ctx.reply(
      "😔 Hozircha mavjud balonlar yo'q.",
      { reply_markup: await getMainMenu(ctx) }
    );
    return;
  }

  const kb = new InlineKeyboard();
  for (const r of result.rows) {
    kb.text(`🛞 ${r.razmer}`, `user_size_${r.razmer}`).row();
  }

  await ctx.reply(
    "🛞 <b>Mavjud razmerlar</b>\n\nO'zingizga kerakli razmerni tanlang:\n\n💡 <i>Har bir razmerda turli brendlar mavjud</i>",
    { reply_markup: kb, parse_mode: "HTML" }
  );
});

// Razmer tanlanganda brendlarni ko'rsatish
bot.callbackQuery(/^user_size_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const razmer = ctx.match[1];

  // Bu razmerdagi mavjud brendlar va narxlar
  const result = await pool.query(`
    SELECT DISTINCT k.balon_turi, 
      (SELECT sotish_narx FROM kirim WHERE razmer = $1 AND balon_turi = k.balon_turi ORDER BY id DESC LIMIT 1) as narx
    FROM kirim k 
    WHERE k.razmer = $1 AND 
      (SELECT COALESCE(SUM(soni), 0) FROM kirim WHERE razmer = $1 AND balon_turi = k.balon_turi) - 
      (SELECT COALESCE(SUM(sotildi), 0) FROM chiqim WHERE razmer = $1 AND balon_turi = k.balon_turi) > 0
    ORDER BY k.balon_turi
  `, [razmer]);

  if (result.rows.length === 0) {
    await ctx.reply("Bu razmerda hozircha mavjud emas", { reply_markup: await getMainMenu(ctx) });
    return;
  }

  let text = `🛞 <b>${razmer}</b>\n\n`;
  text += `📦 Mavjud brendlar va narxlar:\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;

  for (const r of result.rows) {
    const narx = Number(r.narx) || 0;
    text += `🏷 <b>${r.balon_turi}</b>\n`;
    text += `💵 ${formatNumber(narx)} so'm / dona\n\n`;
  }

  text += `━━━━━━━━━━━━━━━━━━\n`;

  const menu = await getMainMenu(ctx);
  const kb = menu === userMenu
    ? new InlineKeyboard().text("📞 Bog'lanish", "user_contact").text("📍 Manzil", "user_location")
    : null;
  await ctx.reply(text, { reply_markup: kb || menu, parse_mode: "HTML" });
});

// Rabochiy Balonlar (mijoz va admin — joriy do'kon / 1)
bot.hears("🔄 Rabochiy Balonlar", async (ctx) => {
  const shopId = ctx.from && (await isAdmin(ctx.from.id)) ? getCurrentShopId(ctx) : 1;
  const result = await pool.query(
    "SELECT * FROM rabochiy_balon WHERE soni > 0 AND (shop_id IS NULL OR shop_id = $1) ORDER BY razmer",
    [shopId]
  );

  if (result.rows.length === 0) {
    await ctx.reply(
      "🔄 <b>Rabochiy balonlar</b>\n\n😔 Hozircha yo'q.",
      { reply_markup: await getMainMenu(ctx), parse_mode: "HTML" }
    );
    return;
  }

  let text = "🔄 <b>Rabochiy Balonlar</b>\n";
  text += "━━━━━━━━━━━━━━━━━━\n\n";
  text += "💡 <i>Sifatli, arzon narxda!</i>\n\n";

  for (const r of result.rows) {
    const holat = r.holat === 'yaxshi' ? '✅ Yaxshi' : r.holat === 'orta' ? '🟡 O\'rta' : '🔴 Past';
    text += `🛞 <b>${r.razmer}</b> | ${r.balon_turi}\n`;
    text += `💵 ${formatNumber(r.narx)} so'm\n`;
    text += `📊 Holat: ${holat}\n\n`;
  }

  text += `━━━━━━━━━━━━━━━━━━\n`;

  await ctx.reply(text, { reply_markup: await getMainMenu(ctx), parse_mode: "HTML" });
});

// Mashinam uchun razmer — mashina tanlab, qanday shina qo'yish mumkinligini ko'rsatish
bot.hears("🚗 Mashinam uchun razmer", async (ctx) => {
  const entries = Object.entries(CAR_TIRE_INFO);
  const kb = new InlineKeyboard();
  for (let i = 0; i < entries.length; i += 2) {
    const [key1, data1] = entries[i];
    kb.text(`🚗 ${data1.name}`, `car_tire_${key1}`);
    if (entries[i + 1]) {
      const [key2, data2] = entries[i + 1];
      kb.text(`🚗 ${data2.name}`, `car_tire_${key2}`);
    }
    kb.row();
  }
  await ctx.reply(
    `🚗 <b>Mashinangiz uchun qanday shina razmeri kerak?</b>\n\n` +
    `Mashinangizni tanlang — sizga tavsiya etiladigan shina o'lchamlari haqida to'liq ma'lumot beramiz.`,
    { reply_markup: kb, parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^car_tire_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const key = ctx.match[1];
  const data = CAR_TIRE_INFO[key];
  if (!data) return;
  const text = data.text + CAR_TIRE_WARNING;
  const kb = new InlineKeyboard()
    .text("🔙 Boshqa mashina", "car_tire_back")
    .row()
    .text("🛞 Yangi Balonlar", "user_go_new")
    .text("🔄 Rabochiy Balonlar", "user_go_rab").row()
    .text("📞 Bog'lanish", "user_contact");
  await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("car_tire_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const entries = Object.entries(CAR_TIRE_INFO);
  const kb = new InlineKeyboard();
  for (let i = 0; i < entries.length; i += 2) {
    const [key1, data1] = entries[i];
    kb.text(`🚗 ${data1.name}`, `car_tire_${key1}`);
    if (entries[i + 1]) {
      const [key2, data2] = entries[i + 1];
      kb.text(`🚗 ${data2.name}`, `car_tire_${key2}`);
    }
    kb.row();
  }
  await ctx.reply("🚗 Mashinangizni tanlang:", { reply_markup: kb, parse_mode: "HTML" });
});

// Mashina ma'lumotidan keyin Yangi/Rabochiy balonlarga o'tish
bot.callbackQuery("user_go_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await pool.query(`
    SELECT DISTINCT k.razmer FROM kirim k 
    WHERE (SELECT COALESCE(SUM(soni), 0) FROM kirim WHERE razmer = k.razmer) - 
          (SELECT COALESCE(SUM(sotildi), 0) FROM chiqim WHERE razmer = k.razmer) > 0
    ORDER BY k.razmer
  `);
  if (result.rows.length === 0) {
    await ctx.reply("😔 Hozircha mavjud balonlar yo'q.", { reply_markup: userMenu });
    return;
  }
  const kb = new InlineKeyboard();
  for (const r of result.rows) kb.text(`🛞 ${r.razmer}`, `user_size_${r.razmer}`).row();
  await ctx.reply("🛞 <b>Mavjud razmerlar</b>\n\nO'zingizga kerakli razmerni tanlang:", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("user_go_rab", async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await pool.query("SELECT * FROM rabochiy_balon WHERE soni > 0 AND (shop_id IS NULL OR shop_id = 1) ORDER BY razmer");
  if (result.rows.length === 0) {
    await ctx.reply("😔 Hozircha rabochiy balonlar yo'q.", { reply_markup: userMenu });
    return;
  }
  let text = "🔄 <b>Rabochiy Balonlar</b>\n━━━━━━━━━━━━━━━━━━\n\n";
  for (const r of result.rows) {
    const holat = r.holat === 'yaxshi' ? '✅' : r.holat === 'orta' ? '🟡' : '🔴';
    text += `🛞 ${r.razmer} | ${r.balon_turi} — ${formatNumber(r.narx)} so'm ${holat}\n`;
  }
  await ctx.reply(text, { reply_markup: userMenu, parse_mode: "HTML" });
});

// Manzil - geo lokatsiya bilan
bot.hears("📍 Manzil", async (ctx) => {
  const address = await getSetting("address");
  const lat = parseFloat(await getSetting("latitude"));
  const lon = parseFloat(await getSetting("longitude"));
  const workingHours = await getSetting("working_hours");
  const shopName = await getSetting("shop_name");

  await ctx.reply(
    `📍 <b>${shopName}</b>\n\n` +
    `🏠 ${address}\n` +
    `🕐 Ish vaqti: ${workingHours}\n\n` +
    `👇 Lokatsiyani pastda ko'ring:`,
    { parse_mode: "HTML" }
  );

  // Geo lokatsiya yuborish
  if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
    await ctx.replyWithLocation(lat, lon);
  }
});

bot.callbackQuery("user_location", async (ctx) => {
  await ctx.answerCallbackQuery();
  const lat = parseFloat(await getSetting("latitude"));
  const lon = parseFloat(await getSetting("longitude"));
  
  if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
    await ctx.replyWithLocation(lat, lon);
  } else {
    const address = await getSetting("address");
    await ctx.reply(`📍 Manzil: ${address}`);
  }
});

// Aloqa
bot.hears("📞 Aloqa", async (ctx) => {
  const phone = await getSetting("phone");
  const shopName = await getSetting("shop_name");
  const workingHours = await getSetting("working_hours");

  await ctx.reply(
    `📞 <b>Bog'lanish</b>\n\n` +
    `🏪 ${shopName}\n\n` +
    `📱 Telefon: ${phone}\n` +
    `🕐 Ish vaqti: ${workingHours}\n\n` +
    `✅ Qo'ng'iroq qiling - bepul konsultatsiya!\n` +
    `🚗 Yetkazib berish mavjud!`,
    { reply_markup: userMenu, parse_mode: "HTML" }
  );
});

bot.callbackQuery("user_contact", async (ctx) => {
  await ctx.answerCallbackQuery();
  const phone = await getSetting("phone");
  await ctx.reply(`📞 Telefon: ${phone}\n\nQo'ng'iroq qiling!`);
});

// ==================== BOSS: DO'KON TANLASH VA BOSHQARUV ====================
bot.hears("📂 Do'kon tanlash", async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const shops = await pool.query("SELECT id, name FROM shops ORDER BY id");
  if (shops.rows.length === 0) {
    await ctx.reply("Hali do'konlar yo'q. Avval \"Do'konlar boshqaruvi\" orqali do'kon qo'shing.");
    return;
  }
  const kb = new InlineKeyboard();
  for (const s of shops.rows) {
    kb.text(s.name, `switch_shop_${s.id}`).row();
  }
  await ctx.reply("📂 Qaysi do'konda ishlashni xohlaysiz?", { reply_markup: kb });
});

bot.callbackQuery(/^switch_shop_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = parseInt(ctx.match[1], 10);
  const r = await pool.query("SELECT name FROM shops WHERE id = $1", [shopId]);
  if (r.rows.length === 0) return ctx.reply("Do'kon topilmadi.");
  ctx.session.shopId = shopId;
  await ctx.reply(`✅ Joriy do'kon: <b>${r.rows[0].name}</b>`, { parse_mode: "HTML", reply_markup: bossMenu });
});

bot.hears("🏢 Do'konlar boshqaruvi", async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const shops = await pool.query("SELECT id, name FROM shops ORDER BY id");
  const kb = new InlineKeyboard();
  for (const s of shops.rows) {
    kb.text(`${s.name}`, `boss_shop_${s.id}`).row();
  }
  kb.text("➕ Yangi do'kon qo'shish", "boss_add_shop").row();
  kb.text("👤 Adminlarni do'konga biriktirish", "boss_manage_admins");
  await ctx.reply(
    "🏢 <b>Do'konlar boshqaruvi</b>\n\nDo'konlarni tanlang yoki adminlarni birlashtiring:",
    { reply_markup: kb, parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^boss_shop_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = parseInt(ctx.match[1], 10);
  const shop = await pool.query("SELECT * FROM shops WHERE id = $1", [shopId]);
  if (shop.rows.length === 0) return;
  const s = shop.rows[0];
  const admins = await pool.query("SELECT telegram_id FROM shop_admins WHERE shop_id = $1", [shopId]);
  const list = admins.rows.length ? admins.rows.map((a) => a.telegram_id).join(", ") : "Yo'q";
  await ctx.reply(
    `🏪 <b>${s.name}</b>\n` +
    `📞 ${s.phone || "-"}\n` +
    `📍 ${s.address || "-"}\n` +
    `💵 Kurs: ${s.dollar_kurs || "-"}\n\n` +
    `👤 Adminlar (Telegram ID): ${list}`,
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("boss_add_shop", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "boss_new_shop_name";
  await ctx.reply("Yangi do'kon nomini kiriting:", { reply_markup: backBtn });
});

bot.callbackQuery("boss_manage_admins", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shops = await pool.query("SELECT id, name FROM shops ORDER BY id");
  const kb = new InlineKeyboard();
  for (const s of shops.rows) {
    kb.text(`${s.name} — admin qo'shish`, `boss_add_admin_shop_${s.id}`).row();
    kb.text(`${s.name} — adminlar ro'yxati`, `boss_list_admins_${s.id}`).row();
  }
  kb.text("🔙 Orqaga", "boss_back");
  await ctx.reply("👤 Adminlarni qaysi do'kon bo'yicha boshqarmoqchisiz?", { reply_markup: kb });
});

bot.callbackQuery(/^boss_add_admin_shop_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = parseInt(ctx.match[1], 10);
  ctx.session.step = "boss_admin_telegram_id";
  ctx.session.data = { boss_shop_id: shopId };
  await ctx.reply("Adminning Telegram ID sini kiriting (masalan: 123456789). ID ni @userinfobot orqali bilib olish mumkin:", { reply_markup: backBtn });
});

bot.callbackQuery(/^boss_list_admins_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = parseInt(ctx.match[1], 10);
  const shop = await pool.query("SELECT name FROM shops WHERE id = $1", [shopId]);
  const admins = await pool.query("SELECT telegram_id FROM shop_admins WHERE shop_id = $1", [shopId]);
  if (admins.rows.length === 0) {
    await ctx.reply(`"${shop.rows[0]?.name || shopId}" do'konida adminlar yo'q. "Admin qo'shish" orqali qo'shing.`);
    return;
  }
  const kb = new InlineKeyboard();
  for (const a of admins.rows) {
    const tid = a.telegram_id;
    if (Number(tid) === BOSS_ADMIN_TELEGRAM_ID) continue;
    kb.text(`ID ${tid} olib tashlash`, `boss_remove_admin_${shopId}_${tid}`).row();
  }
  kb.text("🔙 Orqaga", "boss_back");
  await ctx.reply(`👤 "${shop.rows[0]?.name || shopId}" do'koni adminlari:\n\nOlib tashlash uchun tugmani bosing:`, { reply_markup: kb });
});

bot.callbackQuery(/^boss_remove_admin_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = parseInt(ctx.match[1], 10);
  const telegramId = parseInt(ctx.match[2], 10);
  if (telegramId === BOSS_ADMIN_TELEGRAM_ID) return ctx.reply("Boss adminni olib tashlash mumkin emas.");
  await pool.query("DELETE FROM shop_admins WHERE shop_id = $1 AND telegram_id = $2", [shopId, telegramId]);
  await ctx.reply(`✅ Admin (ID: ${telegramId}) ushbu do'kondan olib tashlandi.`);
});

bot.callbackQuery("boss_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Bosh menyu", { reply_markup: bossMenu });
});

// ==================== ADMIN PANEL ====================

// KIRIM
bot.hears("📦 Kirim", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;

  const kb = new InlineKeyboard()
    .text("➕ Yangi kirim", "kirim_new").text("📷 Rasm orqali kirim", "kirim_photo").row()
    .text("📋 Royxat", "kirim_list");

  await ctx.reply("📦 <b>Kirim bo'limi</b>\n\nTovar qabul qilish:", 
    { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("kirim_photo", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "kirim_photo";
  ctx.session.data = {};
  await ctx.reply("📷 Chek yoki jadval rasmini yuboring. Rasmda mahsulot nomi, soni va narxlari koʻrinishi kerak.", { reply_markup: backBtn });
});

bot.callbackQuery("kirim_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "kirim_size";
  ctx.session.data = {};
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  const kb = await sizeKeyboard("ks");
  kb.text("✏️ Yangi razmer", "ks_new");
  await ctx.reply("📏 <b>Razmer</b> tanlang yoki yangi razmer kiriting:", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("ks_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "kirim_size_new";
  await ctx.reply("Yangi razmerni kiriting (masalan: 205/55 R16):", { reply_markup: backBtn });
});

bot.callbackQuery(/^ks_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.razmer = ctx.match[1];
  ctx.session.step = "kirim_brand";
  const kb = await brandKeyboard("kb");
  kb.text("✏️ Yangi brend", "kb_new");
  await ctx.reply(
    `📏 Razmer: <b>${ctx.match[1]}</b>\n\n🏷 Brend tanlang yoki yangi brend kiriting:`,
    { reply_markup: kb, parse_mode: "HTML" }
  );
});

bot.callbackQuery("kb_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "kirim_brand_new";
  await ctx.reply("Yangi brend nomini kiriting:", { reply_markup: backBtn });
});

bot.callbackQuery(/^kb_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.balon_turi = ctx.match[1];
  ctx.session.step = "kirim_soni";
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  await ctx.reply(
    `✅ <b>${ctx.match[1]}</b> tanlandi.\n\n📏 Razmer: <b>${ctx.session.data.razmer}</b>\n🏷 Brend: <b>${ctx.match[1]}</b>\n\n🔢 <b>Nechta keldi?</b> sonini yozing:`,
    { reply_markup: backBtn, parse_mode: "HTML" }
  );
});

bot.callbackQuery("kirim_list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  const result = await pool.query("SELECT * FROM kirim WHERE (shop_id IS NULL OR shop_id = $1) ORDER BY id DESC LIMIT 15", [shopId]);

  if (result.rows.length === 0) {
    await ctx.reply("Kirim ro'yxati bo'sh");
    return;
  }

  const kurs = parseInt(await getSetting("dollar_kurs", shopId)) || 1;
  let text = "<b>Kirimlar ro'yxati (so'ngi 15)</b>\n";
  text += "━━━━━━━━━━━━━━━━━━\n";
  for (const r of result.rows) {
    const inDollar = r.dollar_kurs === 1;
    const tanD = inDollar ? String(r.kelgan_narx) : (kurs ? (r.kelgan_narx / kurs).toFixed(1) : "-");
    const sotishD = inDollar ? String(r.sotish_narx) : (kurs ? (r.sotish_narx / kurs).toFixed(1) : "-");
    const tanSom = inDollar && kurs ? formatNumber(r.kelgan_narx * kurs) : formatNumber(r.kelgan_narx);
    const sotishSom = inDollar && kurs ? formatNumber(r.sotish_narx * kurs) : formatNumber(r.sotish_narx);
    text += `ID: <b>${r.id}</b> | 🛞 ${r.razmer} | ${r.balon_turi}\n`;
    text += `📥 ${r.soni} ta | 💵 ${tanD} $ (${tanSom} so'm) | 💰 ${sotishD} $ (${sotishSom} so'm)\n`;
    text += `📅 ${formatDate(r.sana)}\n\n`;
  }
  text += "━━━━━━━━━━━━━━━━━━\n";
  text += "💡 Tahrirlash va o'chirish uchun Sozlamalar bo'limiga o'ting.";
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.callbackQuery("kirim_som", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.data) ctx.session.data = {};
  ctx.session.data.narx_type = "som";
  ctx.session.step = "kirim_kelgan_narx";
  await ctx.reply("💵 Kelgan narxini kiriting (1 dona, so'm):", { reply_markup: backBtn });
});

bot.callbackQuery("kirim_dollar", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.data) ctx.session.data = {};
  ctx.session.data.narx_type = "dollar";
  ctx.session.step = "kirim_kelgan_narx";
  await ctx.reply("💵 Kelgan narxini kiriting (1 dona, $):", { reply_markup: backBtn });
});

bot.callbackQuery("kirim_sotish_som", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.data) ctx.session.data = {};
  ctx.session.data.sotish_type = "som";
  ctx.session.step = "kirim_sotish_narx";
  await ctx.reply("💰 Sotish narxini kiriting (1 dona, so'm):", { reply_markup: backBtn });
});

bot.callbackQuery("kirim_sotish_dollar", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.data) ctx.session.data = {};
  ctx.session.data.sotish_type = "dollar";
  ctx.session.step = "kirim_sotish_narx";
  await ctx.reply("💰 Sotish narxini kiriting (1 dona, $):", { reply_markup: backBtn });
});

// CHIQIM
bot.hears("💰 Chiqim", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;

  const kb = new InlineKeyboard()
    .text("➕ Yangi sotuv", "chiqim_new").row()
    .text("📋 Royxat", "chiqim_list");

  await ctx.reply("💰 <b>Sotish bo'limi</b>", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("chiqim_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "chiqim_size";
  ctx.session.data = {};
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  const shopId = getCurrentShopId(ctx);
  const sizesWithStock = await getSizesWithStock(shopId);
  if (sizesWithStock.length === 0) {
    await ctx.reply("❌ Omborda hozircha tovar yo'q. Avval kirim qiling.");
    return;
  }
  const kb = new InlineKeyboard();
  for (let i = 0; i < sizesWithStock.length; i += 2) {
    const a = sizesWithStock[i], b = sizesWithStock[i + 1];
    if (b) kb.text(`🛞 ${a}`, `cs_${a}`).text(`🛞 ${b}`, `cs_${b}`).row();
    else kb.text(`🛞 ${a}`, `cs_${a}`).row();
  }
  await ctx.reply("📏 <b>Skladda bor</b> razmerlardan tanlang:", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery(/^cs_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const razmer = ctx.match[1];
  ctx.session.data.razmer = razmer;
  ctx.session.step = "chiqim_brand";
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  const shopId = getCurrentShopId(ctx);
  const brandsWithStock = await getBrandsWithStock(razmer, shopId);
  if (brandsWithStock.length === 0) {
    await ctx.reply("❌ Bu razmerda omborda tovar yo'q.");
    return;
  }
  const kb = new InlineKeyboard();
  for (const b of brandsWithStock) {
    kb.text(`🏷 ${b}`, `cb_${b}`).row();
  }
  await ctx.reply(
    `✅ Razmer: <b>${razmer}</b>\n\n🏷 <b>Skladda bor</b> brendlardan tanlang:`,
    { reply_markup: kb, parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^cb_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const razmer = ctx.session.data.razmer;
  const balon_turi = ctx.match[1];
  ctx.session.data.balon_turi = balon_turi;
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  const shopId = getCurrentShopId(ctx);
  const stock = await getStock(razmer, balon_turi, shopId);
  ctx.session.step = "chiqim_soni";
  await ctx.reply(
    `✅ <b>${balon_turi}</b> tanlandi.\n\n📏 Razmer: <b>${razmer}</b>\n🏷 Brend: <b>${balon_turi}</b>\n📦 Omborda: <b>${stock} ta</b>\n\n🔢 <b>Nechta sotildi?</b> sonini yozing:`,
    { reply_markup: backBtn, parse_mode: "HTML" }
  );
});

bot.callbackQuery("chiqim_list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  const result = await pool.query("SELECT * FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1) ORDER BY id DESC LIMIT 15", [shopId]);

  if (result.rows.length === 0) {
    await ctx.reply("Sotuvlar ro'yxati bo'sh");
    return;
  }

  let text = "<b>Sotuvlar ro'yxati (so'ngi 15)</b>\n";
  text += "━━━━━━━━━━━━━━━━━━\n";
  for (const r of result.rows) {
    text += `ID: <b>${r.id}</b> | 🛞 ${r.razmer} | ${r.balon_turi}\n`;
    text += `📤 ${r.sotildi} ta = ${formatNumber(r.umumiy_qiymat)} so'm`;
    if (r.rabochiy_olindi > 0) {
      const rabSum = (r.rabochiy_olindi || 0) * (r.rabochiy_narxi || 0);
      text += ` (-${formatNumber(rabSum)} rabochiy)`;
    }
    text += `\n📈 Foyda: ${formatNumber(r.foyda)} so'm`;
    if (r.naqd_foyda != null || r.zaxira_foyda != null) {
      text += ` (Naqd: ${formatNumber(r.naqd_foyda || 0)}`;
      if ((r.zaxira_foyda || 0) > 0) text += `, Zaxira: ${formatNumber(r.zaxira_foyda)}`;
      text += `)`;
    }
    text += `\n📅 ${formatDate(r.sana)}\n\n`;
  }
  text += "━━━━━━━━━━━━━━━━━━\n";
  text += "💡 Tahrirlash va o'chirish uchun Sozlamalar bo'limiga o'ting.";
  await ctx.reply(text, { parse_mode: "HTML" });
});

// XISOBOT
bot.hears("📊 Xisobot", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;

  const kb = new InlineKeyboard()
    .text("📊 Umumiy", "rep_all").text("📅 Bugungi", "rep_today").row()
    .text("📦 Qoldiq", "rep_stock").text("🔄 Ombor (Eski)", "rep_rab_ombor").row()
    .text("📥 Excel yuklab olish", "rep_excel_menu");

  await ctx.reply("📊 <b>Xisobot turi tanlang:</b>", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("rep_rab_ombor", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  const { soni, summa } = await getRabochiyOmborValue(shopId);
  await ctx.reply(
    `🔄 <b>Ombor (Eski balonlar)</b>\n\n` +
    `Hozirda omboringizda <b>${formatNumber(summa)} so'm</b> lik <b>${soni} ta</b> rabochiy balon bor.`,
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("rep_all", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);

  const result = await pool.query(`
    SELECT k.razmer, k.balon_turi,
      COALESCE(SUM(k.soni), 0) as kirdi,
      ROUND(AVG(k.kelgan_narx)) as tan_narxi
    FROM kirim k
    WHERE (k.shop_id IS NULL OR k.shop_id = $1)
    GROUP BY k.razmer, k.balon_turi
    ORDER BY k.razmer
  `, [shopId]);

  if (result.rows.length === 0) {
    await ctx.reply("Ma'lumot yo'q");
    return;
  }

  let text = "📊 <b>UMUMIY XISOBOT</b>\n━━━━━━━━━━━━━━━━━━\n\n";
  let totalFoyda = 0;

  for (const r of result.rows) {
    const sotildi = await pool.query(
      "SELECT COALESCE(SUM(sotildi), 0) as s, COALESCE(SUM(foyda), 0) as f FROM chiqim WHERE razmer = $1 AND balon_turi = $2 AND (shop_id IS NULL OR shop_id = $3)",
      [r.razmer, r.balon_turi, shopId]
    );
    const sold = Number(sotildi.rows[0].s);
    const foyda = Number(sotildi.rows[0].f);
    const qoldi = Number(r.kirdi) - sold;

    text += `🛞 <b>${r.razmer}</b> | ${r.balon_turi}\n`;
    text += `📥 ${r.kirdi} | 📤 ${sold} | 📦 ${qoldi}\n`;
    text += `💵 Tan: ${formatNumber(r.tan_narxi)} | Foyda: ${formatNumber(foyda)}\n\n`;
    totalFoyda += foyda;
  }

  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `💰 <b>JAMI FOYDA: ${formatNumber(totalFoyda)} so'm</b>`;
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.callbackQuery("rep_today", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  const chiqimRows = await pool.query(
    "SELECT * FROM chiqim WHERE sana = CURRENT_DATE AND (shop_id IS NULL OR shop_id = $1)",
    [shopId]
  );
  const rabSotuvRows = await pool.query(
    "SELECT * FROM rabochiy_sotuv WHERE sana = CURRENT_DATE AND (shop_id IS NULL OR shop_id = $1)",
    [shopId]
  );

  let naqdTushum = 0, naqdFoyda = 0, rabQoshildiSoni = 0, rabQoshildiSumma = 0, zaxiraFoyda = 0;
  for (const r of chiqimRows.rows) {
    const rabSum = (r.rabochiy_olindi || 0) * (r.rabochiy_narxi || 0);
    naqdTushum += Number(r.umumiy_qiymat) - rabSum;
    naqdFoyda += Number(r.naqd_foyda || 0);
    zaxiraFoyda += Number(r.zaxira_foyda || 0);
    rabQoshildiSoni += Number(r.rabochiy_olindi || 0);
    rabQoshildiSumma += rabSum;
  }
  let eskiBalonFoyda = 0;
  for (const r of rabSotuvRows.rows) {
    eskiBalonFoyda += Number(r.sotilgan_narx || 0) - Number(r.olingan_narx || 0);
  }
  const jamiFoyda = naqdFoyda + zaxiraFoyda + eskiBalonFoyda;

  let text = "📅 <b>BUGUNGI HISOBOT</b>\n━━━━━━━━━━━━━━━━━━\n\n";
  text += `💵 <b>Naqd tushum:</b> ${formatNumber(naqdTushum)} so'm\n`;
  text += `📈 <b>Sof naqd foyda:</b> ${formatNumber(naqdFoyda)} so'm\n`;
  text += `🔄 <b>Omborga qo'shildi (Rabochiy):</b> ${rabQoshildiSoni} ta — ${formatNumber(rabQoshildiSumma)} so'm\n`;
  text += `🛞 <b>Eski balondan kelgan sof foyda:</b> ${formatNumber(eskiBalonFoyda)} so'm\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `💰 <b>Jami foyda:</b> ${formatNumber(jamiFoyda)} so'm`;

  if (chiqimRows.rows.length > 0 || rabSotuvRows.rows.length > 0) {
    text += `\n\n━━ <i>Tafsilot</i> ━━\n`;
    for (const r of chiqimRows.rows) {
      text += `\n🛞 ${r.razmer} | ${r.balon_turi}: ${r.sotildi} ta = ${formatNumber(r.umumiy_qiymat)} so'm`;
      if (r.naqd_foyda != null) text += ` (Naqd: ${formatNumber(r.naqd_foyda)})`;
      if ((r.zaxira_foyda || 0) > 0) text += ` [Zaxira: ${formatNumber(r.zaxira_foyda)}]`;
    }
  }
  await ctx.reply(text || "📅 Bugun operatsiyalar yo'q", { parse_mode: "HTML" });
});

bot.callbackQuery("rep_stock", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  const rows = await getSkladRowsWithValuation(shopId);

  if (rows.length === 0) {
    await ctx.reply("Ma'lumot yo'q");
    return;
  }

  let text = "📦 <b>QOLDIQ</b>\n━━━━━━━━━━━━━━━━━━\n\n";
  let investitsiyaSum = 0;
  let kutilayotganFoydaSum = 0;

  for (const r of rows) {
    const qoldi = Number(r.qoldiq);
    const tanNarx = Number(r.tan_narx);
    const jami = qoldi * tanNarx;
    investitsiyaSum += jami;
    kutilayotganFoydaSum += qoldi * (Number(r.sotish_narx) - tanNarx);
    text += `🛞 ${r.razmer} | ${r.balon_turi}: <b>${qoldi} ta</b>\n`;
    text += `💰 Sklad tannarxi: <b>${formatNumber(jami)} so'm</b>\n\n`;
  }

  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `💵 <b>Investitsiya (Skladdagi pulingiz): ${formatNumber(investitsiyaSum)} so'm</b>\n`;
  text += `📈 <b>Kutilayotgan sof foyda: ${formatNumber(kutilayotganFoydaSum)} so'm</b>`;

  await ctx.reply(text || "Ombor bo'sh", { parse_mode: "HTML" });
});

// Excel: davr bo'yicha boshlang'ich va tugash sanasi
function getDateRange(periodType) {
  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);
  let startDate = endDate;
  if (periodType === "day") {
    startDate = endDate;
  } else if (periodType === "week") {
    const start = new Date(now);
    start.setDate(now.getDate() - 6);
    startDate = start.toISOString().slice(0, 10);
  } else if (periodType === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    startDate = start.toISOString().slice(0, 10);
  } else if (periodType === "year") {
    startDate = `${now.getFullYear()}-01-01`;
  }
  return { startDate, endDate };
}

// Excel: Ma'lumot varaqasiga sana va dollar kursini qo'shish
async function addExcelInfoSheet(workbook, shopId = 1) {
  const infoSheet = workbook.addWorksheet("Ma'lumot", { properties: { tabColor: { argb: "FFD3D3D3" } } });
  const sana = new Date().toLocaleString("uz-UZ");
  const dollarKurs = await getSetting("dollar_kurs", shopId) || "-";
  infoSheet.columns = [
    { header: "Parametr", key: "param", width: 20 },
    { header: "Qiymat", key: "value", width: 40 }
  ];
  infoSheet.addRow({ param: "Yaratilgan sana", value: sana });
  infoSheet.addRow({ param: "Dollar kursi (so'm)", value: String(dollarKurs) });
}

// Excel yuklab olish – bosh menyu (qisqa)
bot.callbackQuery("rep_excel_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text("📊 Xisobot (umumiy)", "excel_xisobot").row()
    .text("📤 Chiqim", "excel_chiqim").text("📥 Kirim", "excel_kirim").row()
    .text("📦 Sklad", "excel_sklad").text("🔄 Rabochiy", "excel_rabochiy");
  await ctx.reply("📥 <b>Excel yuklab olish</b>\n\nTurini tanlang:", { reply_markup: kb, parse_mode: "HTML" });
});

// Chiqim / Kirim – davr tanlash
bot.callbackQuery("excel_chiqim", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text("Kunlik", "excel_chiqim_day").text("Haftalik", "excel_chiqim_week").row()
    .text("Oylik", "excel_chiqim_month").text("Yillik", "excel_chiqim_year").row()
    .text("Umumiy", "excel_chiqim_all");
  await ctx.editMessageText("📤 <b>Chiqim</b> – davrni tanlang:", { reply_markup: kb, parse_mode: "HTML" });
});
bot.callbackQuery("excel_kirim", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text("Kunlik", "excel_kirim_day").text("Haftalik", "excel_kirim_week").row()
    .text("Oylik", "excel_kirim_month").text("Yillik", "excel_kirim_year").row()
    .text("Umumiy", "excel_kirim_all");
  await ctx.editMessageText("📥 <b>Kirim</b> – davrni tanlang:", { reply_markup: kb, parse_mode: "HTML" });
});

async function editToLoading(ctx, label) {
  try {
    await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, `⏳ ${label} tayyorlanmoqda...`);
  } catch (_) {}
}
async function editToDone(ctx, label) {
  try {
    await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, `✅ ${label} yuborildi!`);
  } catch (_) {}
}

function toDollar(som, kurs) {
  if (!kurs || kurs <= 0) return String(som ?? 0);
  return (Number(som || 0) / kurs).toFixed(2);
}

async function generateExcelAndSend(ctx, reportType, periodType) {
  try {
    const shopId = getCurrentShopId(ctx);
    const workbook = new ExcelJS.Workbook();
    await addExcelInfoSheet(workbook, shopId);
    const dateStr = new Date().toISOString().slice(0, 10);
    const kurs = parseFloat(await getSetting("dollar_kurs", shopId)) || 1;

    if (reportType === "xisobot") {
      // Umumiy xisobot – bosh ko'rsatkichlar (dollarda, rabochiy so'mda)
      const [jamiChiqim, kirimSums, jamiFoyda, skladValuation, rabochiyCount, chiqimTotals] = await Promise.all([
        pool.query("SELECT COALESCE(SUM(umumiy_qiymat), 0) as s, COALESCE(SUM(foyda), 0) as f FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1)", [shopId]).then(r => ({ sum: Number(r.rows[0].s), foyda: Number(r.rows[0].f) })),
        pool.query("SELECT COALESCE(SUM(CASE WHEN COALESCE(dollar_kurs,0) = 1 THEN umumiy_qiymat ELSE 0 END), 0) as dollar_sum, COALESCE(SUM(CASE WHEN COALESCE(dollar_kurs,0) <> 1 THEN umumiy_qiymat ELSE 0 END), 0) as soom_sum FROM kirim WHERE (shop_id IS NULL OR shop_id = $1)", [shopId]).then(r => ({ dollar_sum: Number(r.rows[0].dollar_sum), soom_sum: Number(r.rows[0].soom_sum) })),
        pool.query("SELECT COALESCE(SUM(foyda), 0) as f FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1)", [shopId]).then(r => Number(r.rows[0].f)),
        getSkladValuationByTannarx(shopId),
        pool.query("SELECT COALESCE(SUM(soni), 0) as c FROM rabochiy_balon WHERE (shop_id IS NULL OR shop_id = $1)", [shopId]).then(r => Number(r.rows[0].c)),
        pool.query("SELECT COALESCE(SUM(sotildi), 0) as sotildi, COALESCE(SUM(naqd_foyda), 0) as naqd_foyda, COALESCE(SUM(zaxira_foyda), 0) as zaxira_foyda FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1)", [shopId]).then(r => ({ sotildi: Number(r.rows[0].sotildi), naqd_foyda: Number(r.rows[0].naqd_foyda), zaxira_foyda: Number(r.rows[0].zaxira_foyda) }))
      ]);
      const jamiKirim = kirimSums.soom_sum + kirimSums.dollar_sum * kurs;
      const qoldiqRows = await getSkladRowsWithValuation(shopId);
      const jamiQoldiq = qoldiqRows.reduce((a, r) => a + Number(r.qoldiq || 0), 0);
      const jamiQoldiqQiymatTannarx = qoldiqRows.reduce((a, r) => a + Number(r.qoldiq || 0) * Number(r.tan_narx || 0), 0);
      const umSheet = workbook.addWorksheet("Umumiy xisobot");
      umSheet.columns = [
        { header: "Ko'rsatkich", key: "name", width: 28 },
        { header: "Qiymat", key: "value", width: 20 }
      ];
      const rabOmbor = await getRabochiyOmborValue(shopId);
      umSheet.addRow({ name: "Jami qoldiq (dona)", value: String(jamiQoldiq) });
      umSheet.addRow({ name: "Jami qoldiq qiymat tannarx ($)", value: toDollar(jamiQoldiqQiymatTannarx, kurs) });
      umSheet.addRow({ name: "Jami sotildi (dona)", value: String(chiqimTotals.sotildi) });
      umSheet.addRow({ name: "Jami naqd foyda ($)", value: toDollar(chiqimTotals.naqd_foyda, kurs) });
      umSheet.addRow({ name: "Jami zaxira ($)", value: toDollar(chiqimTotals.zaxira_foyda, kurs) });
      umSheet.addRow({ name: "Jami foyda ($)", value: toDollar(jamiFoyda, kurs) });
      umSheet.addRow({ name: "Jami kirim ($)", value: toDollar(jamiKirim, kurs) });
      umSheet.addRow({ name: "Jami chiqim/sotuv ($)", value: toDollar(jamiChiqim.sum, kurs) });
      umSheet.addRow({ name: "Investitsiya (Skladdagi pulingiz) ($)", value: toDollar(skladValuation.investitsiya, kurs) });
      umSheet.addRow({ name: "Kutilayotgan sof foyda ($)", value: toDollar(skladValuation.kutilayotganFoyda, kurs) });
      umSheet.addRow({ name: "Eski balonlar ombori (so'm)", value: formatNumber(rabOmbor.summa) + " (" + rabOmbor.soni + " ta)" });
      umSheet.addRow({ name: "Rabochiy balonlar (dona)", value: String(rabochiyCount) });
      // Qoldiq qisqacha (qoldiqRows yuqorida olingan)
      const qSheet = workbook.addWorksheet("Qoldiq");
      qSheet.columns = [
        { header: "Razmer", key: "razmer", width: 14 },
        { header: "Brend", key: "balon_turi", width: 20 },
        { header: "Qoldiq", key: "qoldiq", width: 10 },
        { header: "Qoldiq qiymati (tannarx) ($)", key: "jami", width: 22 }
      ];
      for (const r of qoldiqRows) {
        qSheet.addRow({ razmer: r.razmer, balon_turi: r.balon_turi, qoldiq: r.qoldiq, jami: toDollar(Number(r.qoldiq) * Number(r.tan_narx), kurs) });
      }
      // So'ngi chiqimlar (10 ta)
      const chiqimRows = await pool.query("SELECT id, razmer, balon_turi, sotildi, umumiy_qiymat, foyda, naqd_foyda, zaxira_foyda, sana FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1) ORDER BY id DESC LIMIT 10", [shopId]);
      const cSheet = workbook.addWorksheet("So'ngi chiqimlar");
      cSheet.columns = [
        { header: "ID", key: "id", width: 6 },
        { header: "Razmer", key: "razmer", width: 14 },
        { header: "Brend", key: "balon_turi", width: 18 },
        { header: "Sotildi", key: "sotildi", width: 8 },
        { header: "Umumiy ($)", key: "umumiy_qiymat", width: 12 },
        { header: "Naqd foyda ($)", key: "naqd_foyda", width: 12 },
        { header: "Zaxira ($)", key: "zaxira_foyda", width: 12 },
        { header: "Foyda ($)", key: "foyda", width: 12 },
        { header: "Sana", key: "sana", width: 10 }
      ];
      chiqimRows.rows.forEach(row => cSheet.addRow({
        ...row,
        umumiy_qiymat: toDollar(row.umumiy_qiymat, kurs),
        foyda: toDollar(row.foyda, kurs),
        naqd_foyda: row.naqd_foyda != null ? toDollar(row.naqd_foyda, kurs) : "-",
        zaxira_foyda: row.zaxira_foyda != null ? toDollar(row.zaxira_foyda, kurs) : "-"
      }));
      // Bugungi hisobot sheet
      const bugunChiqim = await pool.query("SELECT * FROM chiqim WHERE sana = CURRENT_DATE AND (shop_id IS NULL OR shop_id = $1)", [shopId]);
      const bugunRabSotuv = await pool.query("SELECT * FROM rabochiy_sotuv WHERE sana = CURRENT_DATE AND (shop_id IS NULL OR shop_id = $1)", [shopId]);
      let bugunNaqdTushum = 0, bugunNaqdFoyda = 0, bugunRabQoshildi = 0, bugunZaxira = 0, bugunEskiFoyda = 0;
      for (const r of bugunChiqim.rows) {
        const rs = (r.rabochiy_olindi || 0) * (r.rabochiy_narxi || 0);
        bugunNaqdTushum += Number(r.umumiy_qiymat) - rs;
        bugunNaqdFoyda += Number(r.naqd_foyda || 0);
        bugunZaxira += Number(r.zaxira_foyda || 0);
        bugunRabQoshildi += rs;
      }
      for (const r of bugunRabSotuv.rows) {
        bugunEskiFoyda += Number(r.sotilgan_narx || 0) - Number(r.olingan_narx || 0);
      }
      const bugunSheet = workbook.addWorksheet("Bugungi hisobot");
      bugunSheet.columns = [{ header: "Ko'rsatkich", key: "name", width: 35 }, { header: "Qiymat", key: "value", width: 25 }];
      bugunSheet.addRow({ name: "Naqd tushum (so'm)", value: formatNumber(bugunNaqdTushum) });
      bugunSheet.addRow({ name: "Sof naqd foyda (so'm)", value: formatNumber(bugunNaqdFoyda) });
      bugunSheet.addRow({ name: "Omborga qo'shildi (Rabochiy) (so'm)", value: formatNumber(bugunRabQoshildi) });
      bugunSheet.addRow({ name: "Eski balondan kelgan sof foyda (so'm)", value: formatNumber(bugunEskiFoyda) });
      bugunSheet.addRow({ name: "Jami foyda (so'm)", value: formatNumber(bugunNaqdFoyda + bugunZaxira + bugunEskiFoyda) });
      // So'ngi kirimlar (10 ta)
      const kirimRows = await pool.query("SELECT id, razmer, balon_turi, soni, umumiy_qiymat, sana FROM kirim WHERE (shop_id IS NULL OR shop_id = $1) ORDER BY id DESC LIMIT 10", [shopId]);
      const kSheet = workbook.addWorksheet("So'ngi kirimlar");
      kSheet.columns = [
        { header: "ID", key: "id", width: 6 },
        { header: "Razmer", key: "razmer", width: 14 },
        { header: "Brend", key: "balon_turi", width: 18 },
        { header: "Soni", key: "soni", width: 6 },
        { header: "Umumiy ($)", key: "umumiy_qiymat", width: 12 },
        { header: "Sana", key: "sana", width: 10 }
      ];
      kirimRows.rows.forEach(row => kSheet.addRow({ ...row, umumiy_qiymat: toDollar(row.umumiy_qiymat, kurs) }));
      await ctx.replyWithDocument(new InputFile(await workbook.xlsx.writeBuffer(), `xisobot_umumiy_${dateStr}.xlsx`));
    } else if (reportType === "chiqim") {
      const { startDate, endDate } = getDateRange(periodType);
      let query = "SELECT id, razmer, balon_turi, sotildi, umumiy_qiymat, foyda, naqd_foyda, zaxira_foyda, rabochiy_olindi, rabochiy_narxi, sana FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1)";
      const params = [shopId];
      if (periodType !== "all") {
        query += " AND sana >= $2 AND sana <= $3";
        params.push(startDate, endDate);
      }
      query += " ORDER BY sana DESC, id DESC";
      const result = await pool.query(query, params);
      const sheet = workbook.addWorksheet("Chiqim");
      sheet.columns = [
        { header: "ID", key: "id", width: 8 },
        { header: "Razmer", key: "razmer", width: 16 },
        { header: "Brend", key: "balon_turi", width: 22 },
        { header: "Sotildi", key: "sotildi", width: 10 },
        { header: "Umumiy ($)", key: "umumiy_qiymat", width: 12 },
        { header: "Naqd foyda ($)", key: "naqd_foyda", width: 12 },
        { header: "Zaxira ($)", key: "zaxira_foyda", width: 12 },
        { header: "Foyda ($)", key: "foyda", width: 12 },
        { header: "Rabochiy soni", key: "rabochiy_olindi", width: 12 },
        { header: "Rabochiy narx (so'm)", key: "rabochiy_narxi", width: 14 },
        { header: "Sana", key: "sana", width: 12 }
      ];
      result.rows.forEach((row) => sheet.addRow({
        ...row,
        umumiy_qiymat: toDollar(row.umumiy_qiymat, kurs),
        foyda: toDollar(row.foyda, kurs),
        naqd_foyda: row.naqd_foyda != null ? toDollar(row.naqd_foyda, kurs) : "-",
        zaxira_foyda: row.zaxira_foyda != null ? toDollar(row.zaxira_foyda, kurs) : "-"
      }));
      await ctx.replyWithDocument(new InputFile(await workbook.xlsx.writeBuffer(), `chiqim_${periodType}_${dateStr}.xlsx`));
    } else if (reportType === "sklad") {
      const rows = await getSkladRowsWithValuation(shopId);
      const sheet = workbook.addWorksheet("Sklad");
      sheet.columns = [
        { header: "Razmer", key: "razmer", width: 16 },
        { header: "Brend", key: "balon_turi", width: 22 },
        { header: "Kirdi (jami)", key: "kirdi", width: 12 },
        { header: "Sotildi (jami)", key: "sotildi", width: 12 },
        { header: "Qoldiq", key: "qoldiq", width: 10 },
        { header: "Tan narx ($)", key: "tan_narx", width: 12 },
        { header: "Sklad tannarxi (Investitsiya) ($)", key: "jami_qiymat", width: 26 },
        { header: "Sotish narxi ($)", key: "sotish_narx", width: 14 },
        { header: "Kutilayotgan foyda ($)", key: "kutilayotgan_foyda", width: 18 }
      ];
      for (const r of rows) {
        const q = Number(r.qoldiq);
        const tan = Number(r.tan_narx);
        const sotish = Number(r.sotish_narx);
        sheet.addRow({
          razmer: r.razmer,
          balon_turi: r.balon_turi,
          kirdi: r.kirdi,
          sotildi: r.sotildi,
          qoldiq: q,
          tan_narx: toDollar(tan, kurs),
          jami_qiymat: toDollar(q * tan, kurs),
          sotish_narx: toDollar(sotish, kurs),
          kutilayotgan_foyda: toDollar(q * (sotish - tan), kurs)
        });
      }
      await ctx.replyWithDocument(new InputFile(await workbook.xlsx.writeBuffer(), `sklad_${dateStr}.xlsx`));
    } else if (reportType === "rabochiy") {
      const result = await pool.query("SELECT id, razmer, balon_turi, soni, narx, holat, sana FROM rabochiy_balon WHERE (shop_id IS NULL OR shop_id = $1) ORDER BY sana DESC, id DESC", [shopId]);
      const sheet = workbook.addWorksheet("Rabochiy");
      sheet.columns = [
        { header: "ID", key: "id", width: 8 },
        { header: "Razmer", key: "razmer", width: 16 },
        { header: "Brend", key: "balon_turi", width: 22 },
        { header: "Soni", key: "soni", width: 8 },
        { header: "Narx (so'm)", key: "narx", width: 14 },
        { header: "Holat", key: "holat", width: 10 },
        { header: "Sana", key: "sana", width: 12 }
      ];
      result.rows.forEach((row) => sheet.addRow(row));
      await ctx.replyWithDocument(new InputFile(await workbook.xlsx.writeBuffer(), `rabochiy_${dateStr}.xlsx`));
    } else if (reportType === "kirim") {
      const { startDate, endDate } = periodType === "all" ? { startDate: "2000-01-01", endDate: "2099-12-31" } : getDateRange(periodType);
      const result = await pool.query(
        `SELECT id, razmer, balon_turi, soni, kelgan_narx, sotish_narx, umumiy_qiymat, sana, dollar_kurs, narx_dona 
         FROM kirim WHERE (shop_id IS NULL OR shop_id = $1) AND sana >= $2 AND sana <= $3 ORDER BY sana DESC, id DESC`,
        [shopId, startDate, endDate]
      );
      const sheet = workbook.addWorksheet("Kirim");
      sheet.columns = [
        { header: "ID", key: "id", width: 8 },
        { header: "Razmer", key: "razmer", width: 16 },
        { header: "Brend", key: "balon_turi", width: 22 },
        { header: "Soni", key: "soni", width: 8 },
        { header: "Kelgan narx ($)", key: "kelgan_narx", width: 14 },
        { header: "Sotish narx ($)", key: "sotish_narx", width: 14 },
        { header: "Umumiy qiymat ($)", key: "umumiy_qiymat", width: 16 },
        { header: "Sana", key: "sana", width: 12 },
        { header: "Kurs", key: "dollar_kurs", width: 8 }
      ];
      result.rows.forEach((row) => {
        const inDollar = row.dollar_kurs === 1;
        sheet.addRow({
          ...row,
          kelgan_narx: inDollar ? row.kelgan_narx : toDollar(row.kelgan_narx, kurs),
          sotish_narx: inDollar ? row.sotish_narx : toDollar(row.sotish_narx, kurs),
          umumiy_qiymat: inDollar ? row.umumiy_qiymat : toDollar(row.umumiy_qiymat, kurs)
        });
      });
      await ctx.replyWithDocument(new InputFile(await workbook.xlsx.writeBuffer(), `kirim_${periodType}_${dateStr}.xlsx`));
    }
  } catch (error) {
    console.error("Excel xatolik:", error);
    await ctx.reply("Xatolik yuz berdi: " + error.message);
    throw error;
  }
}

async function excelWithAnimation(ctx, label, fn) {
  await ctx.answerCallbackQuery();
  await editToLoading(ctx, label);
  try {
    await fn();
    await editToDone(ctx, label);
  } catch (_) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, "❌ Xatolik yuz berdi.");
    } catch (__) {}
  }
}

bot.callbackQuery("excel_xisobot", async (ctx) => excelWithAnimation(ctx, "Xisobot", () => generateExcelAndSend(ctx, "xisobot", "all")));
bot.callbackQuery("excel_chiqim_day", async (ctx) => excelWithAnimation(ctx, "Chiqim", () => generateExcelAndSend(ctx, "chiqim", "day")));
bot.callbackQuery("excel_chiqim_week", async (ctx) => excelWithAnimation(ctx, "Chiqim", () => generateExcelAndSend(ctx, "chiqim", "week")));
bot.callbackQuery("excel_chiqim_month", async (ctx) => excelWithAnimation(ctx, "Chiqim", () => generateExcelAndSend(ctx, "chiqim", "month")));
bot.callbackQuery("excel_chiqim_year", async (ctx) => excelWithAnimation(ctx, "Chiqim", () => generateExcelAndSend(ctx, "chiqim", "year")));
bot.callbackQuery("excel_chiqim_all", async (ctx) => excelWithAnimation(ctx, "Chiqim", () => generateExcelAndSend(ctx, "chiqim", "all")));
bot.callbackQuery("excel_sklad", async (ctx) => excelWithAnimation(ctx, "Sklad", () => generateExcelAndSend(ctx, "sklad", "all")));
bot.callbackQuery("excel_rabochiy", async (ctx) => excelWithAnimation(ctx, "Rabochiy", () => generateExcelAndSend(ctx, "rabochiy", "all")));
bot.callbackQuery("excel_kirim_day", async (ctx) => excelWithAnimation(ctx, "Kirim", () => generateExcelAndSend(ctx, "kirim", "day")));
bot.callbackQuery("excel_kirim_week", async (ctx) => excelWithAnimation(ctx, "Kirim", () => generateExcelAndSend(ctx, "kirim", "week")));
bot.callbackQuery("excel_kirim_month", async (ctx) => excelWithAnimation(ctx, "Kirim", () => generateExcelAndSend(ctx, "kirim", "month")));
bot.callbackQuery("excel_kirim_year", async (ctx) => excelWithAnimation(ctx, "Kirim", () => generateExcelAndSend(ctx, "kirim", "year")));
bot.callbackQuery("excel_kirim_all", async (ctx) => excelWithAnimation(ctx, "Kirim", () => generateExcelAndSend(ctx, "kirim", "all")));

// ROYXAT
bot.hears("📋 Royxat", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;

  const kb = new InlineKeyboard()
    .text("📏 Razmerlar", "list_sizes").text("🏷 Brendlar", "list_brands").row()
    .text("➕ Razmer", "add_size").text("➕ Brend", "add_brand");

  await ctx.reply("📋 <b>Ro'yxatlar</b>", { reply_markup: kb, parse_mode: "HTML" });
});

// Razmer va brend ro'yxatini bitta xabarda chiqarish
async function sendSizesAndBrandsList(ctx) {
  const [sizesRes, brandsRes] = await Promise.all([
    pool.query("SELECT * FROM sizes ORDER BY id"),
    pool.query("SELECT * FROM brands ORDER BY id")
  ]);
  let msg = "📋 <b>Ro'yxatlar</b>\n\n";
  msg += "📏 <b>Razmerlar</b> (ID tartibida):\n";
  if (sizesRes.rows.length === 0) {
    msg += "  — bo'sh\n";
  } else {
    for (const r of sizesRes.rows) {
      msg += `  <b>${r.id}</b>. ${r.name}\n`;
    }
  }
  msg += "\n🏷 <b>Brendlar</b> (ID tartibida):\n";
  if (brandsRes.rows.length === 0) {
    msg += "  — bo'sh\n";
  } else {
    for (const r of brandsRes.rows) {
      msg += `  <b>${r.id}</b>. ${r.name}\n`;
    }
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
}

bot.callbackQuery("list_sizes", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendSizesAndBrandsList(ctx);
});

bot.callbackQuery("list_brands", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendSizesAndBrandsList(ctx);
});

bot.callbackQuery("add_size", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "add_size";
  await ctx.reply("Yangi razmer kiriting (masalan: 205/55 R16):", { reply_markup: backBtn });
});

bot.callbackQuery("add_brand", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "add_brand";
  await ctx.reply("Yangi brend nomini kiriting:", { reply_markup: backBtn });
});

// RABOCHIY BALON
bot.hears("🔄 Rabochiy", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;

  const kb = new InlineKeyboard()
    .text("➕ Qo'shish", "rab_add").text("💰 Rabochiy sotuv", "rab_sotuv").row()
    .text("📋 Ro'yxat", "rab_list");

  await ctx.reply("🔄 <b>Rabochiy balonlar</b>", { reply_markup: kb, parse_mode: "HTML" });
});

// Savat: rabochiy balonlarni tanlash uchun klaviatura
function buildRabSavatKeyboard(rows, selectedIds = []) {
  const kb = new InlineKeyboard();
  for (let i = 0; i < rows.length; i += 2) {
    const a = rows[i];
    const checkA = selectedIds.includes(a.id) ? "✅ " : "";
    kb.text(`${checkA}ID ${a.id}`, `rab_sav_toggle_${a.id}`);
    if (rows[i + 1]) {
      const b = rows[i + 1];
      const checkB = selectedIds.includes(b.id) ? "✅ " : "";
      kb.text(`${checkB}ID ${b.id}`, `rab_sav_toggle_${b.id}`);
    }
    kb.row();
  }
  if (selectedIds.length > 0) {
    kb.text(`💰 Sotishni tasdiqlash (${selectedIds.length} ta)`, "rab_sav_confirm").row();
  }
  kb.text("🔙 Orqaga", "rab_sav_back");
  return kb;
}

bot.callbackQuery("rab_sotuv", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.rab_sav_selected = ctx.session.rab_sav_selected || [];
  const shopId = getCurrentShopId(ctx);
  const result = await pool.query("SELECT * FROM rabochiy_balon WHERE soni > 0 AND (shop_id IS NULL OR shop_id = $1) ORDER BY id", [shopId]);
  if (result.rows.length === 0) {
    await ctx.reply("Rabochiy balonlar yo'q, sotish mumkin emas.");
    return;
  }
  const kb = buildRabSavatKeyboard(result.rows, ctx.session.rab_sav_selected);
  const text = "💰 <b>Eski balon sotish</b>\n\nBalonlarni tanlang (tugmani bosganingizda ✅ belgisi tushadi):\n\n" +
    result.rows.map(r => {
      const holat = r.holat === 'yaxshi' ? '✅' : r.holat === 'orta' ? '🟡' : '🔴';
      return `🔑 ID ${r.id} — ${r.razmer} | ${r.balon_turi} | ${formatNumber(r.narx)} so'm ${holat}`;
    }).join("\n");
  ctx.session.step = "rab_sav_list";
  await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery(/^rab_sav_toggle_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = parseInt(ctx.match[1]);
  ctx.session.rab_sav_selected = ctx.session.rab_sav_selected || [];
  const idx = ctx.session.rab_sav_selected.indexOf(id);
  if (idx >= 0) {
    ctx.session.rab_sav_selected.splice(idx, 1);
  } else {
    ctx.session.rab_sav_selected.push(id);
  }
  const shopId = getCurrentShopId(ctx);
  const result = await pool.query("SELECT * FROM rabochiy_balon WHERE soni > 0 AND (shop_id IS NULL OR shop_id = $1) ORDER BY id", [shopId]);
  const kb = buildRabSavatKeyboard(result.rows, ctx.session.rab_sav_selected);
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
  } catch (_) {}
});

bot.callbackQuery("rab_sav_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.rab_sav_selected = [];
  ctx.session.step = null;
  const kb = new InlineKeyboard()
    .text("➕ Qo'shish", "rab_add").text("💰 Rabochiy sotuv", "rab_sotuv").row()
    .text("📋 Ro'yxat", "rab_list");
  await ctx.editMessageText("🔄 <b>Rabochiy balonlar</b>", { reply_markup: kb, parse_mode: "HTML" }).catch(() => {});
});

bot.callbackQuery("rab_sav_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const selected = ctx.session.rab_sav_selected || [];
  if (selected.length === 0) {
    await ctx.reply("Hech narsa tanlanmadi.");
    return;
  }
  const placeholders = selected.map((_, i) => `$${i + 1}`).join(", ");
  const result = await pool.query(
    `SELECT id, razmer, balon_turi, narx FROM rabochiy_balon WHERE id IN (${placeholders}) AND soni > 0`,
    selected
  );
  if (result.rows.length !== selected.length) {
    await ctx.reply("Ba'zi tanlangan balonlar topilmadi. Qaytadan tanlang.");
    return;
  }
  const totalOlingan = result.rows.reduce((s, r) => s + Number(r.narx), 0);
  ctx.session.data = { rab_sav_ids: selected, rab_sav_rows: result.rows };
  ctx.session.step = "rab_sav_narx";
  ctx.session.rab_sav_selected = [];
  await ctx.reply(
    `💰 <b>Tanlangan ${selected.length} ta balon</b>\n\n` +
    `Jami olingan narx: <b>${formatNumber(totalOlingan)} so'm</b>\n\n` +
    `Bularni jami necha pulga sotdingiz? (so'm):`,
    { reply_markup: backBtn, parse_mode: "HTML" }
  );
});

bot.callbackQuery("rab_add", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "rab_size";
  ctx.session.data = {};
  // Razmer tanlash uchun klaviatura va yangi razmer tugmasi
  const kb = await sizeKeyboard("rs");
  kb.text("✏️ Yangi razmer", "rs_new");
  await ctx.reply("📏 Razmer tanlang yoki yangi razmer kiriting:", { reply_markup: kb });
});

bot.callbackQuery("rs_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "rab_size_new";
  await ctx.reply("Yangi razmerni kiriting (masalan: 205/55 R16):", { reply_markup: backBtn });
});

bot.callbackQuery(/^rs_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.razmer = ctx.match[1];
  ctx.session.step = "rab_brand";
  // Brend tanlash uchun klaviatura va yangi brend tugmasi
  const kb = await brandKeyboard("rb");
  kb.text("✏️ Yangi brend", "rb_new");
  await ctx.reply("🏷 Brend tanlang yoki yangi brend kiriting:", { reply_markup: kb });
});

bot.callbackQuery("rb_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "rab_brand_new";
  await ctx.reply("Yangi brend nomini kiriting:", { reply_markup: backBtn });
});

bot.callbackQuery(/^rb_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.balon_turi = ctx.match[1];
  ctx.session.step = "rab_soni";
  await ctx.reply("🔢 Sonini kiriting:", { reply_markup: backBtn });
});

bot.callbackQuery("rab_list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  const result = await pool.query("SELECT * FROM rabochiy_balon WHERE soni > 0 AND (shop_id IS NULL OR shop_id = $1) ORDER BY id DESC", [shopId]);

  if (result.rows.length === 0) {
    await ctx.reply("Rabochiy balonlar yo'q");
    return;
  }

  let msg = "🔄 <b>Rabochiy balonlar ro'yxati</b>\n\n";
  for (const r of result.rows) {
    const holat = r.holat === 'yaxshi' ? '✅ Yaxshi' : r.holat === 'orta' ? '🟡 O\'rta' : '🔴 Past';
    msg += `🔑 <b>ID: ${r.id}</b> — 🛞 ${r.razmer} | ${r.balon_turi}\n   ${r.soni} ta x ${formatNumber(r.narx)} so'm | ${holat}\n\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

// OLINISH KERAK
bot.hears("🛒 Olinish kerak", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;

  const kb = new InlineKeyboard()
    .text("➕ Qo'shish", "ol_add").row()
    .text("📋 Ro'yxat", "ol_list").row()
    .text("📊 Talab (sotuvlar)", "ol_talab");

  await ctx.reply("🛒 <b>Olinishi kerak</b>", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("ol_add", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "ol_size";
  ctx.session.data = {};
  await ctx.reply("📏 Razmer tanlang:", { reply_markup: await sizeKeyboard("os") });
});

bot.callbackQuery(/^os_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.razmer = ctx.match[1];
  ctx.session.step = "ol_brand";
  await ctx.reply("🏷 Brend tanlang:", { reply_markup: await brandKeyboard("ob") });
});

bot.callbackQuery(/^ob_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.balon_turi = ctx.match[1];
  ctx.session.step = "ol_soni";
  await ctx.reply("🔢 Nechta kerak?", { reply_markup: backBtn });
});

// Avtomatik: qoldiq 4 tadan kam bo'lgan pozitsiyalarni olinish_kerak ga qo'shish
async function syncOlinishKerakFromStock(shopId = 1) {
  const r = await pool.query(`
    WITH agg AS (
      SELECT k.razmer, k.balon_turi, COALESCE(SUM(k.soni), 0) AS kirdi
      FROM kirim k WHERE (k.shop_id IS NULL OR k.shop_id = $1) GROUP BY k.razmer, k.balon_turi
    ),
    outgo AS (
      SELECT razmer, balon_turi, COALESCE(SUM(sotildi), 0) AS sotildi
      FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1) GROUP BY razmer, balon_turi
    ),
    qoldiq AS (
      SELECT a.razmer, a.balon_turi, GREATEST(0, a.kirdi - COALESCE(o.sotildi, 0))::int AS q
      FROM agg a LEFT JOIN outgo o ON a.razmer = o.razmer AND a.balon_turi = o.balon_turi
    ),
    mavjud AS (
      SELECT razmer, balon_turi FROM olinish_kerak WHERE (shop_id IS NULL OR shop_id = $1)
    )
    SELECT q.razmer, q.balon_turi, q.q FROM qoldiq q
    LEFT JOIN mavjud m ON q.razmer = m.razmer AND q.balon_turi = m.balon_turi
    WHERE q.q < 4 AND m.razmer IS NULL
  `, [shopId]);
  for (const row of r.rows) {
    const need = Math.max(1, 4 - row.q);
    await pool.query(
      "INSERT INTO olinish_kerak (razmer, balon_turi, soni, shop_id) VALUES ($1, $2, $3, $4)",
      [row.razmer, row.balon_turi, need, shopId]
    );
  }
}

bot.callbackQuery("ol_list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  await syncOlinishKerakFromStock(shopId);
  const result = await pool.query("SELECT * FROM olinish_kerak WHERE (shop_id IS NULL OR shop_id = $1) ORDER BY id", [shopId]);

  if (result.rows.length === 0) {
    await ctx.reply("Ro'yxat bo'sh. Qoldiq 4 tadan kam bo'lgan pozitsiyalar avtomatik qo'shiladi.");
    return;
  }

  for (const r of result.rows) {
    const kb = new InlineKeyboard().text("✏️ Tahrirlash", `ol_edit_${r.id}`);
    await ctx.reply(
      `🛒 <b>${r.id}</b>. ${r.razmer} | ${r.balon_turi} — ${r.soni} ta`,
      { reply_markup: kb, parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^ol_edit_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = parseInt(ctx.match[1]);
  ctx.session.step = "ol_edit";
  ctx.session.data = ctx.session.data || {};
  ctx.session.data.edit_id = id;
  await ctx.reply("Yangi sonni kiriting:", { reply_markup: backBtn });
});

// Talab (sotuvlar): olinishi kerak pozitsiyalar bo'yicha qancha va qachon sotilgani
bot.callbackQuery("ol_talab", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  await syncOlinishKerakFromStock(shopId);
  const list = await pool.query("SELECT id, razmer, balon_turi, soni FROM olinish_kerak WHERE (shop_id IS NULL OR shop_id = $1) ORDER BY id", [shopId]);
  if (list.rows.length === 0) {
    await ctx.reply("Olinishi kerak ro'yxati bo'sh. Talab ko'rsatiladi ro'yxatdagi pozitsiyalar bo'yicha.");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const day7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const day30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sold7 = await pool.query(
    "SELECT razmer, balon_turi, COALESCE(SUM(sotildi), 0) AS s FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1) AND sana >= $2 GROUP BY razmer, balon_turi",
    [shopId, day7]
  );
  const sold30 = await pool.query(
    "SELECT razmer, balon_turi, COALESCE(SUM(sotildi), 0) AS s FROM chiqim WHERE (shop_id IS NULL OR shop_id = $1) AND sana >= $2 GROUP BY razmer, balon_turi",
    [shopId, day30]
  );
  const map7 = {};
  const map30 = {};
  for (const r of sold7.rows) map7[`${r.razmer}|${r.balon_turi}`] = Number(r.s);
  for (const r of sold30.rows) map30[`${r.razmer}|${r.balon_turi}`] = Number(r.s);
  let msg = "📊 <b>Talab (sotuvlar)</b>\nSo'nggi 7 kun va 30 kun bo'yicha sotilgan dona:\n\n";
  for (const r of list.rows) {
    const key = `${r.razmer}|${r.balon_turi}`;
    const s7 = map7[key] || 0;
    const s30 = map30[key] || 0;
    msg += `🛞 ${r.razmer} | ${r.balon_turi}\n   📅 7 kun: <b>${s7}</b> ta  |  30 kun: <b>${s30}</b> ta\n\n`;
  }
  msg += `📅 7 kun: ${day7} — ${today}\n📅 30 kun: ${day30} — ${today}`;
  await ctx.reply(msg, { parse_mode: "HTML" });
});

// Rasm yuklanganda: Gemini OCR orqali jadval ajratib, natijani konsolga chiqarish
function downloadTelegramFile(token, filePath) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Razmerni 165/70/13 -> 165/70 R13 formatiga (baza uchun)
function sizeToDbFormat(s) {
  if (!s || typeof s !== "string") return s;
  const m = s.trim().match(/(\d{3})[\/\s]*(\d{2})[\/\s]*(\d{2})/);
  return m ? `${m[1]}/${m[2]} R${m[3]}` : s;
}

bot.on("message:photo", async (ctx, next) => {
  const photo = ctx.message.photo;
  if (!photo || photo.length === 0) return next();
  const largest = photo[photo.length - 1];
  const step = ctx.session.step;

  if (step === "kirim_photo") {
    try {
      await ctx.reply("🔄 Rasm tahlil qilinmoqda...");
      const file = await ctx.api.getFile(largest.file_id);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        await ctx.reply("❌ Bot token topilmadi.");
        ctx.session.step = null;
        return;
      }
      const buffer = await downloadTelegramFile(token, file.file_path);
      let rows = null;
      try {
        if (process.env.GEMINI_API_KEY) {
          rows = await extractTableFromImage(buffer);
        }
      } catch (geminiErr) {
        console.log("Gemini OCR ishlamadi, Tesseract ishlatiladi:", geminiErr.message);
      }
      if (!rows || rows.length === 0) {
        rows = await extractTableFromImageTesseract(buffer);
      }
      if (!rows || rows.length === 0) {
        await ctx.reply("❌ Jadvalda qator topilmadi. Boshqa rasm yuboring.", { reply_markup: adminMenu });
        ctx.session.step = null;
        return;
      }
      const shopId = getCurrentShopId(ctx);
      let saved = 0;
      for (const r of rows) {
        const razmer = sizeToDbFormat(r.size) || r.size;
        const balon_turi = (r.brand && String(r.brand).trim()) || "Noma'lum";
        const soni = Math.max(0, Math.round(Number(r.quantity) || 0));
        const kelgan_narx = Math.round(Number(r.price) || 0);
        let sotish_narx = Math.round(Number(r.selling_price) || kelgan_narx + 1);
        if (sotish_narx <= kelgan_narx) sotish_narx = kelgan_narx + 1;
        const umumiy_qiymat = soni * sotish_narx;
        if (soni < 1) continue;
        try {
          await pool.query("INSERT INTO sizes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [razmer]);
          await pool.query("INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [balon_turi]);
          await pool.query(
            `INSERT INTO kirim (razmer, balon_turi, soni, kelgan_narx, sotish_narx, umumiy_qiymat, dollar_kurs, narx_dona, shop_id) VALUES ($1, $2, $3, $4, $5, $6, 1, $4, $7)`,
            [razmer, balon_turi, soni, kelgan_narx, sotish_narx, umumiy_qiymat, shopId]
          );
          saved++;
        } catch (e) {
          console.error("Kirim OCR qator saqlash xato:", e.message, r);
        }
      }
      ctx.session.step = null;
      ctx.session.data = {};
      console.log("=== Rasm orqali kirim saqlandi ===", JSON.stringify(rows, null, 2));
      await ctx.reply(
        `✅ <b>Rasm orqali kirim</b>\n\n${saved} ta qator kirim jadvaliga saqlandi (narxlar $ da).`,
        { reply_markup: adminMenu, parse_mode: "HTML" }
      );
    } catch (err) {
      console.error("Kirim OCR xato:", err);
      ctx.session.step = null;
      await ctx.reply("❌ Rasm tahlil qilishda xato: " + (err.message || String(err)), { reply_markup: adminMenu });
    }
    return;
  }

  // Rasm tahlili faqat Kirim → Rasm yuklash tugmasi bosilganda (kirim_photo) ishlaydi
  await ctx.reply("📷 Kirim jadvali rasmini tahlil qilish uchun avval **Kirim** → **Rasm yuklash** tugmasini bosing.", { parse_mode: "Markdown" });
  return next();
});

// Universal message:text handler (faqat bitta bo'lishi kerak)
bot.on("message:text", async (ctx, next) => {
  const text = ctx.message.text;
  const step = ctx.session.step;

  // Boss - yangi do'kon nomi
  if (step === "boss_new_shop_name" && isBoss(ctx.from.id)) {
    const name = (text || "").trim();
    if (!name) {
      await ctx.reply("❌ Do'kon nomini kiriting");
      return;
    }
    const ins = await pool.query(
      "INSERT INTO shops (name, phone, address, dollar_kurs, report_daily_time, report_weekly_day) VALUES ($1, '', '', '12800', '21:00', '5') RETURNING id",
      [name]
    );
    const newShopId = ins.rows[0].id;
    const defaults = [
      ["shop_name", name], ["phone", ""], ["address", ""], ["dollar_kurs", "12800"],
      ["report_daily_time", "21:00"], ["report_weekly_day", "5"]
    ];
    for (const [k, v] of defaults) {
      await pool.query(
        "INSERT INTO shop_settings (shop_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (shop_id, key) DO UPDATE SET value = $3",
        [newShopId, k, v]
      );
    }
    ctx.session.step = null;
    await ctx.reply(`✅ Do'kon qo'shildi: "${name}" (ID: ${newShopId})`, { reply_markup: bossMenu });
    return;
  }
  // Boss - admin Telegram ID
  if (step === "boss_admin_telegram_id" && isBoss(ctx.from.id)) {
    const tid = parseInt(String(text).replace(/\s/g, ""), 10);
    if (isNaN(tid) || tid <= 0) {
      await ctx.reply("❌ To'g'ri Telegram ID kiriting (faqat raqam)");
      return;
    }
    const shopId = ctx.session.data?.boss_shop_id || 1;
    await pool.query(
      "INSERT INTO shop_admins (telegram_id, shop_id) VALUES ($1, $2) ON CONFLICT (telegram_id, shop_id) DO NOTHING",
      [tid, shopId]
    );
    const shop = await pool.query("SELECT name FROM shops WHERE id = $1", [shopId]);
    ctx.session.step = null;
    ctx.session.data = {};
    await ctx.reply(`✅ Admin (ID: ${tid}) "${shop.rows[0]?.name || shopId}" do'koniga biriktirildi.`, { reply_markup: bossMenu });
    return;
  }

  // Sozlamalar - Dollar kursi
  if (step === "settings_dollar") {
    const kurs = parseInt(text.replace(/\s/g, ""));
    if (isNaN(kurs) || kurs <= 0) {
      await ctx.reply("❌ To'g'ri summani kiriting");
      return;
    }
    const shopId = getCurrentShopId(ctx);
    await setDollarKurs(kurs, shopId);
    ctx.session.step = null;
    const menu = isBoss(ctx.from.id) ? bossMenu : adminMenu;
    await ctx.reply(`✅ Dollar kursi yangilandi: ${formatNumber(kurs)} so'm`, { reply_markup: menu });
    return;
  }
  // Sozlamalar - Do'kon nomi
  if (step === "settings_shop_name") {
    await setSetting("shop_name", text, getCurrentShopId(ctx));
    ctx.session.step = null;
    const menu = isBoss(ctx.from.id) ? bossMenu : adminMenu;
    await ctx.reply(`✅ Do'kon nomi yangilandi: ${text}`, { reply_markup: menu });
    return;
  }
  // Sozlamalar - Telefon
  if (step === "settings_shop_phone") {
    await setSetting("phone", text, getCurrentShopId(ctx));
    ctx.session.step = null;
    const menu = isBoss(ctx.from.id) ? bossMenu : adminMenu;
    await ctx.reply(`✅ Telefon yangilandi: ${text}`, { reply_markup: menu });
    return;
  }
  // Sozlamalar - Manzil
  if (step === "settings_shop_address") {
    await setSetting("address", text, getCurrentShopId(ctx));
    ctx.session.step = null;
    const menu = isBoss(ctx.from.id) ? bossMenu : adminMenu;
    await ctx.reply(`✅ Manzil yangilandi: ${text}`, { reply_markup: menu });
    return;
  }
  // Sozlamalar - Ish vaqti
  if (step === "settings_shop_hours") {
    await setSetting("working_hours", text, getCurrentShopId(ctx));
    ctx.session.step = null;
    const menu = isBoss(ctx.from.id) ? bossMenu : adminMenu;
    await ctx.reply(`✅ Ish vaqti yangilandi: ${text}`, { reply_markup: menu });
    return;
  }
  if (step === "report_daily_time") {
    const trimmed = text.trim();
    if (!/^\d{1,2}:\d{2}$/.test(trimmed)) {
      await ctx.reply("❌ Format: SS:MM (masalan: 21:00)");
      return;
    }
    await setSetting("report_daily_time", trimmed, getCurrentShopId(ctx));
    ctx.session.step = null;
    const menu = isBoss(ctx.from.id) ? bossMenu : adminMenu;
    await ctx.reply(`✅ Kunlik hisobot vaqti: ${trimmed}`, { reply_markup: menu });
    return;
  }
  if (step === "report_weekly_day") {
    const d = parseInt(text.replace(/\s/g, ""));
    if (isNaN(d) || d < 0 || d > 6) {
      await ctx.reply("❌ 0–6 orasida kiriting (0=Yakshanba, 5=Juma)");
      return;
    }
    await setSetting("report_weekly_day", String(d), getCurrentShopId(ctx));
    ctx.session.step = null;
    const days = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];
    const menu = isBoss(ctx.from.id) ? bossMenu : adminMenu;
    await ctx.reply(`✅ Haftalik hisobot kuni: ${days[d]}`, { reply_markup: menu });
    return;
  }

  // Ro'yxat — yangi razmer qo'shish (📋 Royxat → ➕ Razmer)
  if (step === "add_size") {
    const razmer = (text || "").trim();
    if (!razmer) {
      await ctx.reply("❌ Razmerni kiriting (masalan: 205/55 R16)");
      return;
    }
    const sizeNorm = razmer.toUpperCase();
    await pool.query("INSERT INTO sizes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [sizeNorm]);
    ctx.session.step = null;
    const kb = new InlineKeyboard()
      .text("📏 Razmerlar", "list_sizes").text("🏷 Brendlar", "list_brands").row()
      .text("➕ Razmer", "add_size").text("➕ Brend", "add_brand");
    await ctx.reply(`✅ Razmer qo'shildi: <b>${sizeNorm}</b>`, { reply_markup: kb, parse_mode: "HTML" });
    return;
  }
  // Ro'yxat — yangi brend qo'shish (📋 Royxat → ➕ Brend)
  if (step === "add_brand") {
    const brand = (text || "").trim();
    if (!brand) {
      await ctx.reply("❌ Brend nomini kiriting");
      return;
    }
    await pool.query("INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [brand]);
    ctx.session.step = null;
    const kb = new InlineKeyboard()
      .text("📏 Razmerlar", "list_sizes").text("🏷 Brendlar", "list_brands").row()
      .text("➕ Razmer", "add_size").text("➕ Brend", "add_brand");
    await ctx.reply(`✅ Brend qo'shildi: <b>${brand}</b>`, { reply_markup: kb, parse_mode: "HTML" });
    return;
  }

  // Olinishi kerak — soni kiritilganda (qo'shish)
  if (step === "ol_soni") {
    const soni = parseInt(String(text).replace(/\s/g, ""), 10);
    if (isNaN(soni) || soni < 1) {
      await ctx.reply("❌ Musbat son kiriting (nechta kerak)");
      return;
    }
    const shopId = getCurrentShopId(ctx);
    const { razmer, balon_turi } = ctx.session.data || {};
    if (!razmer || !balon_turi) {
      await ctx.reply("❌ Sessiya tugadi. Qaytadan Olinishi kerak → Qo'shish.");
      ctx.session.step = null;
      ctx.session.data = {};
      return;
    }
    await pool.query(
      "INSERT INTO olinish_kerak (razmer, balon_turi, soni, shop_id) VALUES ($1, $2, $3, $4)",
      [razmer, balon_turi, soni, shopId]
    );
    ctx.session.step = null;
    ctx.session.data = {};
    await ctx.reply(`✅ Olinishi kerak qo'shildi: ${razmer} | ${balon_turi} — ${soni} ta`, { reply_markup: adminMenu });
    return;
  }

  // Olinishi kerak — tahrirlash (yangi soni)
  if (step === "ol_edit") {
    const soni = parseInt(String(text).replace(/\s/g, ""), 10);
    if (isNaN(soni) || soni < 1) {
      await ctx.reply("❌ Musbat son kiriting");
      return;
    }
    const id = ctx.session.data?.edit_id;
    if (!id) {
      await ctx.reply("❌ Sessiya tugadi. Ro'yxatdan qayta tahrirlashni tanlang.");
      ctx.session.step = null;
      ctx.session.data = {};
      return;
    }
    const res = await pool.query("UPDATE olinish_kerak SET soni = $1 WHERE id = $2", [soni, id]);
    ctx.session.step = null;
    ctx.session.data = {};
    if (res.rowCount === 0) {
      await ctx.reply("❌ Bunday yozuv topilmadi.");
    } else {
      await ctx.reply(`✏️ Tahrirlandi: olinishi kerak ID ${id} — ${soni} ta`, { reply_markup: adminMenu });
    }
    return;
  }

  // O'chirish/tahrirlash uchun ID kiritish
  if (step === "editdel_id") {
    ctx.session.data = ctx.session.data || {};
    const table = ctx.session.data.editdel_table;
    const id = parseInt(text);
    if (!table || isNaN(id)) {
      await ctx.reply("❌ Jadval yoki ID noto'g'ri");
      ctx.session.step = null;
      ctx.session.data = {};
      return;
    }
    ctx.session.data.editdel_id = id;
    ctx.session.step = "editdel_action";
    const kb = new InlineKeyboard()
      .text("🗑 O'chirish", "editdel_del").text("✏️ Tahrirlash", "editdel_edit").row()
      .text("🔙 Orqaga", "settings_editdel");
    await ctx.reply(`ID: ${id} (${table}) uchun amal tanlang:`, { reply_markup: kb });
    return;
  }
  // Tahrirlash uchun maydon nomi kiritish
  if (step === "editdel_field") {
    ctx.session.data = ctx.session.data || {};
    const field = text.trim().toLowerCase();
    const allowedFields = ["name", "soni", "sotildi", "umumiy_qiymat", "foyda", "naqd_foyda", "zaxira_foyda", "rabochiy_olindi", "rabochiy_narxi", "kelgan_narx", "sotish_narx", "narx", "sana", "razmer", "balon_turi"];
    if (!allowedFields.includes(field)) {
      await ctx.reply("❌ Noma'lum maydon. Ruxsat etilgan: " + allowedFields.join(", "));
      return;
    }
    ctx.session.data.editdel_field = field;
    ctx.session.step = "editdel_value";
    await ctx.reply("Yangi qiymatni kiriting:", { reply_markup: backBtn });
    return;
  }
  // Tahrirlash uchun yangi qiymat kiritish
  if (step === "editdel_value") {
    ctx.session.data = ctx.session.data || {};
    const table = ctx.session.data.editdel_table;
    const id = ctx.session.data.editdel_id;
    const field = ctx.session.data.editdel_field;
    const valueInDollar = ctx.session.data.editdel_value_dollar === true;
    if (!table || id == null) {
      await ctx.reply("❌ Sessiya tugadi. Sozlamalar → O'chirish/tahrirlash dan qaytadan boshlang.");
      ctx.session.step = null;
      ctx.session.data = {};
      return;
    }
    let value = text;
    if (valueInDollar && (field === "kelgan_narx" || field === "sotish_narx")) {
      const dollarNum = parseFloat(text.replace(/\s/g, "").replace(",", "."));
      if (isNaN(dollarNum) || dollarNum < 0) {
        await ctx.reply("❌ To'g'ri summa kiriting (dollar, masalan: 32 yoki 32.5)");
        return;
      }
      const shopId = getCurrentShopId(ctx);
      const kurs = parseInt(await getSetting("dollar_kurs", shopId)) || 1;
      value = Math.round(dollarNum * kurs);
    } else if (["soni", "sotildi", "umumiy_qiymat", "foyda", "naqd_foyda", "zaxira_foyda", "rabochiy_olindi", "rabochiy_narxi", "kelgan_narx", "sotish_narx", "narx"].includes(field)) {
      value = parseInt(text.replace(/\s/g, ""), 10);
      if (isNaN(value)) {
        await ctx.reply("❌ To'g'ri son kiriting");
        return;
      }
    } else if (field === "sana") {
      if (!/\d{4}-\d{2}-\d{2}/.test(text.trim())) {
        await ctx.reply("❌ Sana YYYY-MM-DD formatda bo'lishi kerak");
        return;
      }
      value = text.trim();
    } else {
      value = text.trim();
    }
    // Kirim jadvalida "narx" ustuni yo'q — kelgan_narx (tan narx) ga yo'naltiramiz
    const fieldMap = {
      kirim: { narx: "kelgan_narx" },
      chiqim: {},
      olinish_kerak: {},
      sizes: {},
      brands: {}
    };
    const resolvedField = (fieldMap[table] && fieldMap[table][field]) ? fieldMap[table][field] : field;
    try {
      const quotedField = `"${String(resolvedField).replace(/"/g, '""')}"`;
      const res = await pool.query(`UPDATE ${table} SET ${quotedField} = $1 WHERE id = $2`, [value, id]);
      if (res.rowCount === 0) {
        await ctx.reply("❌ Bunday ID topilmadi yoki tahrirlanmadi");
      } else {
        if (table === "kirim" && resolvedField === "sotish_narx") {
          await pool.query("UPDATE kirim SET umumiy_qiymat = soni * sotish_narx WHERE id = $1", [id]);
        }
        const msg = valueInDollar && (field === "kelgan_narx" || field === "sotish_narx")
          ? `✏️ Tahrirlandi: ${resolvedField} = ${formatNumber(value)} so'm`
          : `✏️ Tahrirlandi: ${table} (ID: ${id})`;
        await ctx.reply(msg, { reply_markup: adminMenu });
      }
    } catch (e) {
      await ctx.reply("❌ Tahrirlashda xatolik: " + (e.message || e));
    }
    ctx.session.step = null;
    ctx.session.data = {};
    return;
  }
  // Kirim - soni
  if (step === "kirim_soni") {
    const soni = parseInt(text.replace(/\s/g, ""));
    if (isNaN(soni) || soni <= 0) {
      await ctx.reply("❌ Musbat son kiriting");
      return;
    }
    ctx.session.data.soni = soni;
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    const kb = new InlineKeyboard().text("💵 So'm", "kirim_som").text("💲 Dollar", "kirim_dollar");
    await ctx.reply(
      `✅ <b>${soni} ta</b> qabul qilindi.\n\n💵 <b>Tan narxini</b> qanday kiritasiz?`,
      { reply_markup: kb, parse_mode: "HTML" }
    );
    return;
  }
  // Kirim - kelgan narx (1 dona)
  if (step === "kirim_kelgan_narx") {
    const num = parseFloat(text.replace(/\s/g, "").replace(",", "."));
    if (isNaN(num) || num < 0) {
      await ctx.reply("❌ To'g'ri son kiriting");
      return;
    }
    ctx.session.data.kelgan_narx_input = num;
    ctx.session.step = "kirim_sotish_type";
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    const kb = new InlineKeyboard().text("💵 So'm", "kirim_sotish_som").text("💲 Dollar", "kirim_sotish_dollar");
    await ctx.reply(
      `✅ Tan narx: <b>${num}</b> ${ctx.session.data.narx_type === "dollar" ? "$" : "so'm"}\n\n💰 <b>Sotish narxini</b> qanday kiritasiz? (So'm yoki Dollar tugmasini bosing, yoki to'g'ridan-to'g'ri summani yozing)`,
      { reply_markup: kb, parse_mode: "HTML" }
    );
    return;
  }
  // Kirim - sotish narx: tugmani bosmasdan to'g'ridan-to'g'ri raqam yozilsa (so'm deb hisoblanadi)
  if (step === "kirim_sotish_type") {
    const num = parseFloat(String(text).replace(/\s/g, "").replace(",", "."));
    if (!isNaN(num) && num >= 0) {
      ctx.session.data = ctx.session.data || {};
      ctx.session.data.sotish_type = "som";
      await saveKirimWithSotishNarx(ctx, num, "som");
      return;
    }
  }
  // Kirim - sotish narx (1 dona) va saqlash
  if (step === "kirim_sotish_narx") {
    ctx.session.data = ctx.session.data || {};
    const num = parseFloat(String(text).replace(/\s/g, "").replace(",", "."));
    if (isNaN(num) || num < 0) {
      await ctx.reply("❌ To'g'ri son kiriting");
      return;
    }
    const sotishType = ctx.session.data.sotish_type || "som";
    await saveKirimWithSotishNarx(ctx, num, sotishType);
    return;
  }
  // Chiqim - sotildi soni
  if (step === "chiqim_soni") {
    const soni = parseInt(text.replace(/\s/g, ""));
    if (isNaN(soni) || soni <= 0) {
      await ctx.reply("❌ Musbat son kiriting");
      return;
    }
    const { razmer, balon_turi } = ctx.session.data;
    const stock = await getStock(razmer, balon_turi);
    if (soni > stock) {
      await ctx.reply(`❌ Omborda faqat ${stock} ta mavjud. Kamroq kiriting:`);
      return;
    }
    ctx.session.data.sotildi = soni;
    ctx.session.step = "chiqim_umumiy";
    await ctx.reply(
      `✅ <b>${soni} ta</b> qabul qilindi.\n\n💰 <b>Necha pulga sottiz?</b> (umumiy summani so'm da kiriting):`,
      { reply_markup: backBtn, parse_mode: "HTML" }
    );
    return;
  }
  // Chiqim - umumiy summa (necha pulga sotilgani)
  if (step === "chiqim_umumiy") {
    const umumiy = parseInt(text.replace(/\s/g, ""));
    if (isNaN(umumiy) || umumiy < 0) {
      await ctx.reply("❌ To'g'ri summani kiriting");
      return;
    }
    ctx.session.data.umumiy = umumiy;
    ctx.session.step = "chiqim_rab";
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    const kb = new InlineKeyboard().text("Ha, rabochiy oldim", "rab_yes").text("Yo'q", "rab_no");
    await ctx.reply(
      `✅ Umumiy: <b>${formatNumber(umumiy)} so'm</b>\n\n🔄 Mijozdan rabochiy balon oldingizmi?`,
      { reply_markup: kb, parse_mode: "HTML" }
    );
    return;
  }
  // Kirim - yangi razmer kiritilgach (📦 Kirim → Yangi kirim → Yangi razmer)
  if (step === "kirim_size_new") {
    const razmer = (text || "").trim();
    if (!razmer) {
      await ctx.reply("❌ Razmerni kiriting (masalan: 205/55 R16)");
      return;
    }
    const sizeNorm = razmer.toUpperCase();
    await pool.query("INSERT INTO sizes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [sizeNorm]);
    ctx.session.data = ctx.session.data || {};
    ctx.session.data.razmer = sizeNorm;
    ctx.session.step = "kirim_brand";
    const kbBrand = await brandKeyboard("kb");
    kbBrand.text("✏️ Yangi brend", "kb_new");
    await ctx.reply(
      `📏 Razmer: <b>${sizeNorm}</b>\n\n🏷 Brend tanlang yoki yangi brend kiriting:`,
      { reply_markup: kbBrand, parse_mode: "HTML" }
    );
    return;
  }
  // Kirim - yangi brend kiritilgach (📦 Kirim → Yangi kirim → Yangi brend)
  if (step === "kirim_brand_new") {
    const brand = (text || "").trim();
    if (!brand) {
      await ctx.reply("❌ Brend nomini kiriting");
      return;
    }
    await pool.query("INSERT INTO brands (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [brand]);
    ctx.session.data = ctx.session.data || {};
    ctx.session.data.balon_turi = brand;
    ctx.session.step = "kirim_soni";
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    await ctx.reply(
      `✅ <b>${brand}</b> tanlandi.\n\n📏 Razmer: <b>${ctx.session.data.razmer}</b>\n🏷 Brend: <b>${brand}</b>\n\n🔢 <b>Nechta keldi?</b> sonini yozing:`,
      { reply_markup: backBtn, parse_mode: "HTML" }
    );
    return;
  }
  // Rabochiy balon - yangi razmer kiritilgach (Kirim → Rabochiy → Qo'shish → Yangi razmer)
  if (step === "rab_size_new") {
    const razmer = (text || "").trim();
    if (!razmer) {
      await ctx.reply("❌ Razmerni kiriting (masalan: 205/55 R16)");
      return;
    }
    const sizeNorm = razmer.toUpperCase();
    await pool.query("INSERT INTO sizes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [sizeNorm]);
    ctx.session.data = ctx.session.data || {};
    ctx.session.data.razmer = sizeNorm;
    ctx.session.step = "rab_brand";
    const kb = await brandKeyboard("rb");
    kb.text("✏️ Yangi brend", "rb_new");
    await ctx.reply("🏷 Brend tanlang yoki yangi brend kiriting:", { reply_markup: kb });
    return;
  }
  // Rabochiy balon - yangi brend nomi kiritilgach
  if (step === "rab_brand_new") {
    const name = text.trim();
    if (!name) {
      await ctx.reply("❌ Brend nomini kiriting");
      return;
    }
    ctx.session.data.balon_turi = name;
    ctx.session.step = "rab_soni";
    await ctx.reply("🔢 Sonini kiriting:", { reply_markup: backBtn });
    return;
  }
  // Rabochiy balon qo'shish - soni
  if (step === "rab_soni") {
    const soni = parseInt(text.replace(/\s/g, ""));
    if (isNaN(soni) || soni <= 0) {
      await ctx.reply("❌ Musbat son kiriting");
      return;
    }
    ctx.session.data.soni = soni;
    ctx.session.step = "rab_narx";
    await ctx.reply("💵 Narxini kiriting (1 dona, so'm):", { reply_markup: backBtn });
    return;
  }
  // Rabochiy balon qo'shish - narx, keyin holat tugmalari
  if (step === "rab_narx") {
    const narx = parseInt(text.replace(/\s/g, ""));
    if (isNaN(narx) || narx < 0) {
      await ctx.reply("❌ To'g'ri summani kiriting");
      return;
    }
    ctx.session.data.narx = narx;
    ctx.session.step = "rab_holat";
    const kb = new InlineKeyboard()
      .text("✅ Yaxshi", "rh_yaxshi").text("🟡 O'rta", "rh_orta").text("🔴 Past", "rh_past");
    await ctx.reply("📊 Holatini tanlang:", { reply_markup: kb });
    return;
  }
  // Chiqim - rabochiy yangi razmer (o'zi kiritadi)
  if (step === "chiqim_rab_razmer_new") {
    const raz = text.trim();
    if (!raz) {
      await ctx.reply("❌ Razmerni kiriting");
      return;
    }
    ctx.session.data.rabochiy_razmer = raz;
    ctx.session.step = "chiqim_rab_brand_input";
    await ctx.reply("🏷 Balon (brend) nomini kiriting:", { reply_markup: backBtn });
    return;
  }
  // Chiqim - rabochiy yangi brend (cr_rb_new orqali kelsa)
  if (step === "chiqim_rab_brand_new") {
    const brand = text.trim();
    if (!brand) {
      await ctx.reply("❌ Brend nomini kiriting");
      return;
    }
    ctx.session.data.rabochiy_balon_turi = brand;
    ctx.session.step = "chiqim_rab_narx";
    await ctx.reply("💵 Rabochiy balon narxini kiriting (1 dona, so'm):", { reply_markup: backBtn });
    return;
  }
  // Chiqim - rabochiy soni
  if (step === "chiqim_rab_soni") {
    const soni = parseInt(text.replace(/\s/g, ""));
    if (isNaN(soni) || soni < 0) {
      await ctx.reply("❌ Musbat son kiriting");
      return;
    }
    ctx.session.data.rabochiy_soni = soni;
    const { razmer, balon_turi } = ctx.session.data;
    const kb = new InlineKeyboard()
      .text("Sotilgan balon razmerida", "cr_rab_same")
      .text("Razmerni o'zim kiritaman", "cr_rab_other");
    await ctx.reply(
      `✅ ${soni} ta rabochiy.\n\n📏 Rabochiy balon razmeri: sotilgan (${razmer}) razmerida yoki o'zingiz yozasiz?`,
      { reply_markup: kb }
    );
    return;
  }
  // Chiqim - rabochiy balon nomi (brend) — foydalanuvchi o'zi yozadi
  if (step === "chiqim_rab_brand_input") {
    const name = text.trim();
    if (!name) {
      await ctx.reply("❌ Balon (brend) nomini kiriting");
      return;
    }
    ctx.session.data.rabochiy_balon_turi = name;
    ctx.session.step = "chiqim_rab_narx";
    await ctx.reply("💵 Rabochiy balon narxini kiriting (1 dona, so'm):", { reply_markup: backBtn });
    return;
  }
  // Chiqim - rabochiy narx (keyin holat so'raladi)
  if (step === "chiqim_rab_narx") {
    const narx = parseInt(text.replace(/\s/g, ""));
    if (isNaN(narx) || narx < 0) {
      await ctx.reply("❌ To'g'ri summani kiriting");
      return;
    }
    ctx.session.data.rabochiy_narx = narx;
    ctx.session.step = "chiqim_rab_holat";
    const kb = new InlineKeyboard()
      .text("✅ Yaxshi", "cr_holat_yaxshi").text("🟡 O'rta", "cr_holat_orta").text("🔴 Past", "cr_holat_past");
    await ctx.reply("📊 Rabochiy balon holatini tanlang:", { reply_markup: kb });
    return;
  }
  // Rabochiy balon savat - jami sotilgan narx (ommaviy sotish)
  if (step === "rab_sav_narx") {
    const sotilganSumma = parseInt(text.replace(/\s/g, ""));
    if (isNaN(sotilganSumma) || sotilganSumma < 0) {
      await ctx.reply("❌ To'g'ri summani kiriting");
      return;
    }
    const { rab_sav_ids, rab_sav_rows } = ctx.session.data || {};
    if (!rab_sav_ids?.length || !rab_sav_rows?.length) {
      await ctx.reply("❌ Sessiya tugadi. Qaytadan tanlang.");
      ctx.session.step = null;
      ctx.session.data = {};
      return;
    }
    const totalOlingan = rab_sav_rows.reduce((s, r) => s + Number(r.narx), 0);
    const sotilganPerItem = Math.round(sotilganSumma / rab_sav_rows.length);
    const shopId = getCurrentShopId(ctx);
    for (const row of rab_sav_rows) {
      await pool.query(
        "INSERT INTO rabochiy_sotuv (rabochiy_balon_id, razmer, balon_turi, olingan_narx, sotilgan_narx, shop_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [row.id, row.razmer, row.balon_turi, row.narx, sotilganPerItem, shopId]
      );
    }
    const placeholders = rab_sav_ids.map((_, i) => `$${i + 1}`).join(", ");
    await pool.query(`DELETE FROM rabochiy_balon WHERE id IN (${placeholders})`, rab_sav_ids);
    ctx.session.step = null;
    ctx.session.data = {};
    const foyda = sotilganSumma - totalOlingan;
    await ctx.reply(
      `✅ <b>${rab_sav_rows.length} ta rabochiy balon sotildi!</b>\n\n` +
      `📥 Jami olingan: ${formatNumber(totalOlingan)} so'm\n` +
      `💰 Jami sotilgan: ${formatNumber(sotilganSumma)} so'm\n` +
      `📈 Sof foyda (korrektirovka): ${formatNumber(foyda)} so'm`,
      { reply_markup: adminMenu, parse_mode: "HTML" }
    );
    return;
  }
  // Qo'llab-quvvatlanmaydigan step yoki boshqa matn - keyingi handlerlarga uzatish
  await next();
});

// Rabochiy holat callbacks (yaxshi, orta, past) — saqlagach ID qaytariladi
bot.callbackQuery(/^rh_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const holat = ctx.match[1];
  const { razmer, balon_turi, soni, narx } = ctx.session.data;
  const shopId = getCurrentShopId(ctx);

  const res = await pool.query(
    "INSERT INTO rabochiy_balon (razmer, balon_turi, soni, narx, holat, shop_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [razmer, balon_turi, soni, narx, holat, shopId]
  );
  const newId = res.rows[0]?.id;

  ctx.session.step = null;
  ctx.session.data = {};

  const holatText = holat === 'yaxshi' ? '✅ Yaxshi' : holat === 'orta' ? '🟡 O\'rta' : '🔴 Past';
  const menu = isBoss(ctx.from.id) ? bossMenu : adminMenu;
  await ctx.reply(
    `✅ <b>Rabochiy balon qo'shildi!</b>\n\n` +
    `🔑 <b>ID: ${newId}</b> — bu raqamni balonga yozib qo'ying (shu ID bo'yicha qaysi balon sotilgani va necha pulga olib qolingani aniq bo'ladi).\n\n` +
    `🛞 ${razmer} | ${balon_turi}\n` +
    `📦 ${soni} ta x ${formatNumber(narx)} so'm\n` +
    `📊 Holat: ${holatText}`,
    { reply_markup: menu, parse_mode: "HTML" }
  );
});

// Chiqim rabochiy callbacks
bot.callbackQuery("rab_yes", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "chiqim_rab_soni";
  await ctx.reply("🔢 Nechta rabochiy balon oldingiz?", { reply_markup: backBtn });
});

bot.callbackQuery("rab_no", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.rabochiy_soni = 0;
  ctx.session.data.rabochiy_narx = 0;
  ctx.session.data.rabochiy_razmer = null;
  ctx.session.data.rabochiy_balon_turi = null;
  ctx.session.data.rabochiy_holat = null;
  await saveChiqim(ctx);
});

// Rabochiy razmer: sotilgan balon razmerida — keyin brend nomini o'zi yozadi
bot.callbackQuery("cr_rab_same", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.rabochiy_razmer = ctx.session.data.razmer;
  ctx.session.step = "chiqim_rab_brand_input";
  await ctx.reply("🏷 Balon (brend) nomini kiriting:", { reply_markup: backBtn });
});

// Rabochiy razmer: foydalanuvchi o'zi yozadi, keyin brend nomini ham o'zi yozadi
bot.callbackQuery("cr_rab_other", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "chiqim_rab_razmer_new";
  await ctx.reply("📏 Razmerni yozing (masalan: 205/55 R16 yoki 165/70/13):", { reply_markup: backBtn });
});

bot.callbackQuery(/^cr_rs_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.rabochiy_razmer = ctx.match[1];
  ctx.session.step = "chiqim_rab_brand_input";
  await ctx.reply("🏷 Balon (brend) nomini kiriting:", { reply_markup: backBtn });
});

bot.callbackQuery("cr_rs_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "chiqim_rab_razmer_new";
  await ctx.reply("📏 Razmerni yozing (masalan: 205/55 R16):", { reply_markup: backBtn });
});

bot.callbackQuery(/^cr_rb_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.rabochiy_balon_turi = ctx.match[1];
  ctx.session.step = "chiqim_rab_narx";
  await ctx.reply("💵 Rabochiy balon narxini kiriting (1 dona, so'm):", { reply_markup: backBtn });
});

bot.callbackQuery("cr_rb_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "chiqim_rab_brand_new";
  await ctx.reply("🏷 Balon (brend) nomini kiriting:", { reply_markup: backBtn });
});

// Rabochiy holat (chiqimdan qo'shilganda)
bot.callbackQuery(/^cr_holat_(yaxshi|orta|past)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.rabochiy_holat = ctx.match[1];
  await saveChiqim(ctx);
});

async function saveChiqim(ctx) {
  const { razmer, balon_turi, sotildi, umumiy, rabochiy_soni, rabochiy_narx, rabochiy_razmer, rabochiy_balon_turi, rabochiy_holat } = ctx.session.data;
  const shopId = getCurrentShopId(ctx);

  // Naqd Foyda (NF): (Klientdan olingan naqd) - (Sotilgan yangi balonning tannarxi)
  // Zaxira Foyda (ZF): Klientdan olingan rabochiy balonning baholangan narxi
  // Umumiy Foyda (UF): NF + ZF
  const rabochiySumma = (rabochiy_soni || 0) * (rabochiy_narx || 0);
  const naqdTushum = umumiy - rabochiySumma; // Kassaga kirgan real naqd
  const xarajat = (await getKelganNarx(razmer, balon_turi, shopId)) * sotildi;
  const naqdFoyda = Math.round(naqdTushum - xarajat);
  const zaxiraFoyda = rabochiySumma;
  const foyda = naqdFoyda + zaxiraFoyda;

  await pool.query(
    `INSERT INTO chiqim (razmer, balon_turi, sotildi, umumiy_qiymat, foyda, naqd_foyda, zaxira_foyda, rabochiy_olindi, rabochiy_narxi, shop_id) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [razmer, balon_turi, sotildi, umumiy, foyda, naqdFoyda, zaxiraFoyda, rabochiy_soni || 0, rabochiy_narx || 0, shopId]
  );

  // Rabochiy omborda saqlash — har bitta uchun alohida qator (razmer/brend/holat admin kiritgan)
  let rabIds = [];
  if (rabochiy_soni > 0 && rabochiy_razmer && rabochiy_balon_turi) {
    const holat = rabochiy_holat || "yaxshi";
    for (let i = 0; i < rabochiy_soni; i++) {
      const r = await pool.query(
        "INSERT INTO rabochiy_balon (razmer, balon_turi, soni, narx, holat, shop_id) VALUES ($1, $2, 1, $3, $4, $5) RETURNING id",
        [rabochiy_razmer, rabochiy_balon_turi, rabochiy_narx, holat, shopId]
      );
      rabIds.push(r.rows[0].id);
    }
  }

  ctx.session.step = null;
  ctx.session.data = {};

  await syncOlinishKerakFromStock(shopId);

  let msg = `✅ <b>Sotuv saqlandi!</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
    `🛞 ${razmer} | ${balon_turi}\n` +
    `📤 ${sotildi} ta = ${formatNumber(umumiy)} so'm`;
  if (rabochiy_soni > 0) {
    const rabSum = rabochiy_soni * (rabochiy_narx || 0);
    msg += `\n🔄 Rabochiy: ${rabochiy_soni} ta (${rabochiy_razmer} | ${rabochiy_balon_turi}) — ${formatNumber(rabSum)} so'm ayirildi`;
    if (rabIds.length > 0) {
      msg += `\n🔑 Balon ID lari: ${rabIds.join(", ")} — har bir balonga bitta ID yozib qo'ying.`;
    }
  }
  msg += `\n📈 Naqd foyda: ${formatNumber(naqdFoyda)} so'm`;
  if (zaxiraFoyda > 0) msg += ` | Zaxira: ${formatNumber(zaxiraFoyda)} so'm`;
  msg += `\n📊 Jami foyda: ${formatNumber(foyda)} so'm`;
  await ctx.reply(msg, { reply_markup: adminMenu, parse_mode: "HTML" });
}

// Eski (Rabochiy) balonlar ombori qiymati va soni
async function getRabochiyOmborValue(shopId = 1) {
  const r = await pool.query(
    "SELECT COALESCE(SUM(soni), 0) as soni, COALESCE(SUM(soni * narx), 0) as summa FROM rabochiy_balon WHERE soni > 0 AND (shop_id IS NULL OR shop_id = $1)",
    [shopId]
  );
  return { soni: Number(r.rows[0].soni), summa: Number(r.rows[0].summa) };
}

// Davriy hisobot matnini generatsiya qilish (KUNLIK yoki HAFTALIK) — tannarx mantiqi
async function buildReportText(periodType, startDate, endDate, shopId = 1) {
  const chiqimRows = await pool.query(
    "SELECT * FROM chiqim WHERE sana >= $1 AND sana <= $2 AND (shop_id IS NULL OR shop_id = $3)",
    [startDate, endDate, shopId]
  );
  const rabSotuvRows = await pool.query(
    "SELECT * FROM rabochiy_sotuv WHERE sana >= $1 AND sana <= $2 AND (shop_id IS NULL OR shop_id = $3)",
    [startDate, endDate, shopId]
  );
  const rabOmbor = await getRabochiyOmborValue(shopId);
  const skladVal = await getSkladValuationByTannarx(shopId);

  let naqdTushum = 0, naqdFoyda = 0, zaxiraFoyda = 0;
  for (const r of chiqimRows.rows) {
    const rabSum = (r.rabochiy_olindi || 0) * (r.rabochiy_narxi || 0);
    naqdTushum += Number(r.umumiy_qiymat) - rabSum;
    naqdFoyda += Number(r.naqd_foyda || 0);
    zaxiraFoyda += Number(r.zaxira_foyda || 0);
  }
  let korrektirovka = 0;
  for (const r of rabSotuvRows.rows) {
    korrektirovka += Number(r.sotilgan_narx || 0) - Number(r.olingan_narx || 0);
  }
  const jami = naqdFoyda + zaxiraFoyda + korrektirovka;

  const sanaStr = startDate === endDate ? endDate : `${startDate} — ${endDate}`;
  const periodLabel = periodType === "day" ? "KUNLIK" : "HAFTALIK";

  return (
    `📊 <b>DAVRIY HISOBOT (${periodLabel}):</b>\n` +
    `🗓 Sana: ${sanaStr}\n` +
    `-------------------------\n` +
    `💵 Jami Naqd Tushum: ${formatNumber(naqdTushum)} so'm\n` +
    `💰 Sof Naqd Foyda: ${formatNumber(naqdFoyda)} so'm\n` +
    `💵 Investitsiya (Skladdagi pulingiz): ${formatNumber(skladVal.investitsiya)} so'm\n` +
    `📈 Kutilayotgan sof foyda: ${formatNumber(skladVal.kutilayotganFoyda)} so'm\n` +
    `🛞 Ombordagi Eski Balonlar Qiymati: ${formatNumber(rabOmbor.summa)} so'm\n` +
    `🔄 Eski Balon Sotuvidan Sof Foyda: ${formatNumber(korrektirovka)} so'm\n` +
    `📈 UMUMIY FOYDA (Real + Zaxira): ${formatNumber(jami)} so'm\n` +
    `-------------------------\n` +
    `Bot: @${(process.env.BOT_USERNAME || "shina_dokon_bot").replace("@", "")}`
  );
}

bot.hears("⚙️ Sozlamalar", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return;
  const shopId = getCurrentShopId(ctx);
  const shopName = await getSetting("shop_name", shopId);
  const phone = await getSetting("phone", shopId);
  const address = await getSetting("address", shopId);
  const dollarKurs = await getSetting("dollar_kurs", shopId);
  const workingHours = await getSetting("working_hours", shopId);

  const infoText =
    `⚙️ <b>Sozlamalar bo'limi</b>\n\n` +
    `📋 <b>Joriy sozlamalar:</b>\n` +
    `🏪 Do'kon: ${shopName || '-'}\n` +
    `📞 Telefon: ${phone || '-'}\n` +
    `📍 Manzil: ${address || '-'}\n` +
    `💵 Dollar kursi: ${dollarKurs ? formatNumber(dollarKurs) + ' so\'m' : '-'}\n` +
    `🕐 Ish vaqti: ${workingHours || '-'}\n`;

  const kb = new InlineKeyboard()
    .text("🔑 Ma'lumot o'chirish/tahrirlash", "settings_editdel").row()
    .text("💵 Dollar kursi", "settings_dollar").text("🏪 Do'kon sozlamalari", "settings_shop").row()
    .text("📊 Hisobotlarni boshqarish", "settings_reports").row()
    .text("🔙 Orqaga", "settings_back");
  await ctx.reply(infoText, { reply_markup: kb, parse_mode: "HTML" });
});

// Hisobotlarni boshqarish
bot.callbackQuery("settings_reports", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  const dailyTime = await getSetting("report_daily_time", shopId) || "21:00";
  const weeklyDay = await getSetting("report_weekly_day", shopId) || "5";
  const dayNames = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];
  const kb = new InlineKeyboard()
    .text("🕐 Kunlik hisobot vaqti", "report_set_daily").row()
    .text("📅 Haftalik hisobot kuni", "report_set_weekly").row()
    .text("🔙 Orqaga", "settings_menu");
  await ctx.reply(
    `📊 <b>Hisobotlarni boshqarish</b>\n\n` +
    `Kunlik hisobot vaqti: <b>${dailyTime}</b>\n` +
    `Haftalik hisobot kuni: <b>${dayNames[parseInt(weeklyDay) || 5]}</b> (0=Yakshanba, 5=Juma)\n\n` +
    `Belgilangan vaqtda hisobot avtomatik yuboriladi.`,
    { reply_markup: kb, parse_mode: "HTML" }
  );
});

bot.callbackQuery("report_set_daily", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "report_daily_time";
  await ctx.reply("Kunlik hisobot vaqtini kiriting (masalan: 21:00):", { reply_markup: backBtn });
});

bot.callbackQuery("report_set_weekly", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "report_weekly_day";
  await ctx.reply("Haftalik hisobot kuni (0=Yakshanba, 1=Dushanba, ..., 6=Shanba). Masalan: 5 — Juma:", { reply_markup: backBtn });
});

// Orqaga - Sozlamalardan bosh menyuga
bot.callbackQuery("settings_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = null;
  ctx.session.data = ctx.session.data || {};
  const menu = isBoss(ctx.from.id) ? bossMenu : adminMenu;
  await ctx.reply("Bosh menyu", { reply_markup: menu });
});

// Dollar kursi o'zgartirish
bot.callbackQuery("settings_dollar", async (ctx) => {
  await ctx.answerCallbackQuery();
  const shopId = getCurrentShopId(ctx);
  const currentKurs = await getSetting("dollar_kurs", shopId);
  ctx.session.step = "settings_dollar";
  await ctx.reply(
    `💵 <b>Dollar kursi o'zgartirish</b>\n\n` +
    `Joriy kurs: ${currentKurs ? formatNumber(currentKurs) + ' so\'m' : 'Belgilanmagan'}\n\n` +
    `Yangi kursni kiriting (so'm):`,
    { reply_markup: backBtn, parse_mode: "HTML" }
  );
});

// Sozlamalar asosiy ekranini qayta ko'rsatish
async function showSettingsMenu(ctx) {
  const shopId = getCurrentShopId(ctx);
  const shopName = await getSetting("shop_name", shopId);
  const phone = await getSetting("phone", shopId);
  const address = await getSetting("address", shopId);
  const dollarKurs = await getSetting("dollar_kurs", shopId);
  const workingHours = await getSetting("working_hours", shopId);
  const infoText =
    `⚙️ <b>Sozlamalar bo'limi</b>\n\n` +
    `📋 <b>Joriy sozlamalar:</b>\n` +
    `🏪 Do'kon: ${shopName || '-'}\n` +
    `📞 Telefon: ${phone || '-'}\n` +
    `📍 Manzil: ${address || '-'}\n` +
    `💵 Dollar kursi: ${dollarKurs ? formatNumber(dollarKurs) + ' so\'m' : '-'}\n` +
    `🕐 Ish vaqti: ${workingHours || '-'}\n`;
  const kb = new InlineKeyboard()
    .text("🔑 Ma'lumot o'chirish/tahrirlash", "settings_editdel").row()
    .text("💵 Dollar kursi", "settings_dollar").text("🏪 Do'kon sozlamalari", "settings_shop").row()
    .text("📊 Hisobotlarni boshqarish", "settings_reports").row()
    .text("🔙 Orqaga", "settings_back");
  return ctx.editMessageText(infoText, { reply_markup: kb, parse_mode: "HTML" }).catch(() =>
    ctx.reply(infoText, { reply_markup: kb, parse_mode: "HTML" })
  );
}

bot.callbackQuery("settings_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = null;
  await showSettingsMenu(ctx);
});

// Do'kon sozlamalari (nom, telefon, manzil, ish vaqti)
bot.callbackQuery("settings_shop", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text("🏪 Do'kon nomi", "shop_name").text("📞 Telefon", "shop_phone").row()
    .text("📍 Manzil", "shop_address").text("🕐 Ish vaqti", "shop_hours").row()
    .text("🔙 Orqaga", "settings_menu");
  await ctx.reply("Qaysi sozlamani o'zgartirmoqchisiz?", { reply_markup: kb });
});

bot.callbackQuery("shop_name", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "settings_shop_name";
  await ctx.reply("Yangi do'kon nomini kiriting:", { reply_markup: backBtn });
});
bot.callbackQuery("shop_phone", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "settings_shop_phone";
  await ctx.reply("Yangi telefon raqamini kiriting:", { reply_markup: backBtn });
});
bot.callbackQuery("shop_address", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "settings_shop_address";
  await ctx.reply("Yangi manzilni kiriting:", { reply_markup: backBtn });
});
bot.callbackQuery("shop_hours", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "settings_shop_hours";
  await ctx.reply("Ish vaqtini kiriting (masalan: 09:00 - 20:00):", { reply_markup: backBtn });
});

bot.callbackQuery("settings_editdel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data = ctx.session.data || {};
  ctx.session.step = "editdel_table";
  const kb = new InlineKeyboard()
    .text("Kirim", "editdel_kirim").text("Chiqim", "editdel_chiqim").row()
    .text("Olinish kerak", "editdel_ol").row()
    .text("Razmer", "editdel_size").text("Brend", "editdel_brand").row()
    .text("🔙 Orqaga", "settings_back");
  await ctx.reply("Qaysi jadvaldan o'chirish/tahrirlash?", { reply_markup: kb });
});

// editdel_del va editdel_edit regex dan OLDIN bo'lishi kerak!
bot.callbackQuery("editdel_del", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data = ctx.session.data || {};
  const table = ctx.session.data.editdel_table;
  const id = ctx.session.data.editdel_id;
  if (!table || !id) {
    await ctx.reply("❌ Jadval yoki ID noto'g'ri");
    ctx.session.step = null;
    ctx.session.data = {};
    return;
  }
  try {
    const res = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    if (res.rowCount === 0) {
      await ctx.reply("❌ Bunday ID topilmadi yoki allaqachon o'chirilgan");
    } else {
      await ctx.reply(`🗑 O'chirildi: ${table} (ID: ${id})`, { reply_markup: adminMenu });
    }
  } catch (e) {
    await ctx.reply("❌ O'chirishda xatolik: " + e.message);
  }
  ctx.session.step = null;
  ctx.session.data = {};
});

bot.callbackQuery("editdel_edit", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data = ctx.session.data || {};
  const table = ctx.session.data.editdel_table;
  const id = ctx.session.data.editdel_id;
  if (table === "kirim") {
    ctx.session.step = "editdel_field";
    const kb = new InlineKeyboard()
      .text("💵 Kelgan narx ($)", "editdel_f_kelgan_narx").text("💰 Sotish narx ($)", "editdel_f_sotish_narx").row()
      .text("🔢 Soni", "editdel_f_soni").text("📅 Sana", "editdel_f_sana").row()
      .text("📏 Razmer", "editdel_f_razmer").text("🏷 Brend", "editdel_f_balon_turi").row()
      .text("🔙 Orqaga", "settings_editdel");
    await ctx.reply(`ID: <b>${id}</b> (kirim) – qaysi maydonni tahrirlaysiz?\n\n💲 Kelgan narx va Sotish narxni <b>dollar ($)</b> da kiriting.`, { reply_markup: kb, parse_mode: "HTML" });
    return;
  }
  ctx.session.step = "editdel_field";
  await ctx.reply("Qaysi maydonni tahrirlaysiz? (maydon nomini yozing, masalan: soni, narx, sana, name, ...)", { reply_markup: backBtn });
});

// Kirim (va boshqa) jadvalda maydonni tugma orqali tanlash
bot.callbackQuery(/^editdel_f_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const field = ctx.match[1];
  ctx.session.data = ctx.session.data || {};
  ctx.session.data.editdel_field = field;
  const dollarFields = ["kelgan_narx", "sotish_narx"];
  if (dollarFields.includes(field)) {
    ctx.session.data.editdel_value_dollar = true;
    await ctx.reply("Yangi qiymatni kiriting (dollar, $):", { reply_markup: backBtn });
  } else {
    ctx.session.data.editdel_value_dollar = false;
    await ctx.reply("Yangi qiymatni kiriting:", { reply_markup: backBtn });
  }
  ctx.session.step = "editdel_value";
});

bot.callbackQuery(/^editdel_(kirim|chiqim|ol|size|brand)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data = ctx.session.data || {};
  const tableMap = {
    kirim: "kirim",
    chiqim: "chiqim",
    ol: "olinish_kerak",
    size: "sizes",
    brand: "brands"
  };
  const t = ctx.match[1];
  ctx.session.data.editdel_table = tableMap[t];
  ctx.session.step = "editdel_id";
  await ctx.reply("ID ni kiriting (o'chirish/tahrirlash uchun):", { reply_markup: backBtn });
});

// ==================== AVTOMATIK HISOBOT (CRON) ====================
const REPORT_TIMEZONE = "Asia/Tashkent"; // O'zbekiston, Toshkent vaqti
const lastDailyByShop = {};
const lastWeeklyByShop = {};
const lastScheduledErrorLog = { msg: "", at: 0 };
const SCHEDULED_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000; // bir xil xato 5 daqiqada 1 marta

/** Hozirgi vaqt va sana Toshkent (O'zbekiston) bo'yicha */
function getTashkentNow() {
  const now = new Date();
  const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: REPORT_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
  const dateStr = dateFmt.format(now).replace(/\//g, "-"); // YYYY-MM-DD
  const timeStr = timeFmt.format(now); // HH:mm
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekKey = `${y}-W${Math.ceil(d / 7)}`;
  return { dateStr, timeStr, dayOfWeek, weekKey };
}

/** Kunlik/haftalik hisobot uchun sana oralig'i Toshkent vaqtiga ko'ra */
function getDateRangeTashkent(periodType) {
  const { dateStr } = getTashkentNow();
  let startDate = dateStr;
  if (periodType === "week") {
    const [y, m, d] = dateStr.split("-").map(Number);
    const end = new Date(Date.UTC(y, m - 1, d));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    startDate = start.toISOString().slice(0, 10);
  }
  return { startDate, endDate: dateStr };
}

function isRetryableNetworkError(e) {
  const code = e?.code || e?.errno;
  return code === "EAI_AGAIN" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || e?.message?.includes("getaddrinfo");
}

async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === maxAttempts || !isRetryableNetworkError(e)) throw e;
      const delayMs = attempt * 2000;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function sendScheduledReports() {
  const { timeStr, dateStr: todayStr, dayOfWeek, weekKey } = getTashkentNow();

  try {
    await withRetry(async () => {
    const shops = await pool.query("SELECT id FROM shops ORDER BY id");
    for (const row of shops.rows) {
      const shopId = row.id;
      const dailyTime = await getSetting("report_daily_time", shopId) || "21:00";
      const weeklyDay = parseInt(await getSetting("report_weekly_day", shopId) || "5");
      const adminRows = await pool.query("SELECT telegram_id FROM shop_admins WHERE shop_id = $1", [shopId]);
      let adminIds = adminRows.rows.map((r) => Number(r.telegram_id));
      if (!adminIds.includes(BOSS_ADMIN_TELEGRAM_ID)) adminIds = [...adminIds, BOSS_ADMIN_TELEGRAM_ID];
      if (adminIds.length === 0) continue;

      if (timeStr === dailyTime) {
        if (lastDailyByShop[shopId] !== todayStr) {
          const { startDate, endDate } = getDateRangeTashkent("day");
          const text = await buildReportText("day", startDate, endDate, shopId);
          const shopName = (await pool.query("SELECT name FROM shops WHERE id = $1", [shopId])).rows[0]?.name || "Do'kon";
          const header = `🏪 <b>${shopName}</b>\n\n`;
          for (const chatId of adminIds) {
            try {
              await bot.api.sendMessage(chatId, header + text, { parse_mode: "HTML" });
            } catch (e) {
              console.warn("Report send error:", e.message);
            }
          }
          lastDailyByShop[shopId] = todayStr;
        }
      }

      if (timeStr === dailyTime && dayOfWeek === weeklyDay && lastWeeklyByShop[shopId] !== weekKey) {
        const { startDate, endDate } = getDateRangeTashkent("week");
        const text = await buildReportText("week", startDate, endDate, shopId);
        const shopName = (await pool.query("SELECT name FROM shops WHERE id = $1", [shopId])).rows[0]?.name || "Do'kon";
        const header = `🏪 <b>${shopName}</b> (haftalik)\n\n`;
        for (const chatId of adminIds) {
          try {
            await bot.api.sendMessage(chatId, header + text, { parse_mode: "HTML" });
          } catch (e) {
            console.warn("Weekly report send error:", e.message);
          }
        }
        lastWeeklyByShop[shopId] = weekKey;
      }
    }
    });
  } catch (e) {
    const msg = e?.message || String(e);
    const now = Date.now();
    if (msg !== lastScheduledErrorLog.msg || now - lastScheduledErrorLog.at > SCHEDULED_ERROR_LOG_INTERVAL_MS) {
      lastScheduledErrorLog.msg = msg;
      lastScheduledErrorLog.at = now;
      console.error("Scheduled report error:", msg);
    }
  }
}

app.get('/', (req, res) => res.send('Bot is running!'));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// ==================== START BOT ====================
async function main() {
  await ensureDollarHistoryTable();
  await initDB();
  await ensureChiqimFoydaColumns();
  await ensureRabochiySotuvTable();
  await ensureShopsAndAdmins();
  await ensureIndexes();
  console.log("🚀 Bot ishga tushdi...");
  const res = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  console.log("Mavjud jadvallar:", res.rows.map(r => r.table_name));
  bot.start();

  cron.schedule("* * * * *", sendScheduledReports);
  console.log("📊 Avtomatik hisobotlar yoqildi");
}

main().catch(console.error);
