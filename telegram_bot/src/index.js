require("dotenv").config();

const { Bot, session, InlineKeyboard, Keyboard, InputFile } = require("grammy");
const { Pool } = require("pg");
const ExcelJS = require("exceljs");

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
        ('working_hours', '09:00 - 20:00')
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

// Dollar kursini o'zgartirganda tarixga yozish
async function setDollarKurs(newKurs) {
  await setSetting("dollar_kurs", newKurs.toString());
  await pool.query("INSERT INTO dollar_history (kurs) VALUES ($1)", [newKurs]);
}

// Kirim va chiqimda kursni olish uchun
async function getKursByDate(date) {
  const res = await pool.query(
    `SELECT kurs FROM dollar_history WHERE changed_at <= $1 ORDER BY changed_at DESC LIMIT 1`,
    [date]
  );
  return Number(res.rows[0]?.kurs || await getSetting("dollar_kurs"));
}

// ==================== HELPER FUNCTIONS ====================
async function getSetting(key) {
  const result = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return result.rows[0]?.value || null;
}

async function setSetting(key, value) {
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
    [key, value]
  );
}

async function getAllSizes() {
  const result = await pool.query("SELECT name FROM sizes ORDER BY name");
  return result.rows.map(r => r.name);
}

async function getAllBrands() {
  const result = await pool.query("SELECT name FROM brands ORDER BY name");
  return result.rows.map(r => r.name);
}

async function getStock(razmer, balon_turi) {
  const kirdi = await pool.query(
    "SELECT COALESCE(SUM(soni), 0) as total FROM kirim WHERE razmer = $1 AND balon_turi = $2",
    [razmer, balon_turi]
  );
  const sotildi = await pool.query(
    "SELECT COALESCE(SUM(sotildi), 0) as total FROM chiqim WHERE razmer = $1 AND balon_turi = $2",
    [razmer, balon_turi]
  );
  return Number(kirdi.rows[0].total) - Number(sotildi.rows[0].total);
}

async function getSotishNarx(razmer, balon_turi) {
  const result = await pool.query(
    "SELECT sotish_narx FROM kirim WHERE razmer = $1 AND balon_turi = $2 ORDER BY id DESC LIMIT 1",
    [razmer, balon_turi]
  );
  return Number(result.rows[0]?.sotish_narx || 0);
}

async function getKelganNarx(razmer, balon_turi) {
  const result = await pool.query(
    "SELECT ROUND(AVG(kelgan_narx)) as avg FROM kirim WHERE razmer = $1 AND balon_turi = $2",
    [razmer, balon_turi]
  );
  return Number(result.rows[0]?.avg || 0);
}

function isAdmin(telegramId) {
  const envAdmins = (process.env.ADMIN_IDS || "").split(",").map(id => parseInt(id.trim()));
  return envAdmins.includes(telegramId);
}

function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatDate(date = new Date()) {
  return new Date(date).toLocaleDateString("ru-RU");
}

// ==================== KEYBOARDS ====================
const adminMenu = new Keyboard()
  .text("📦 Kirim").text("💰 Chiqim").row()
  .text("📊 Xisobot").text("📋 Royxat").row()
  .text("🔄 Rabochiy").text("🛒 Olinish kerak").row()
  .text("⚙️ Sozlamalar")
  .resized();

const userMenu = new Keyboard()
  .text("🛞 Yangi Balonlar").row()
  .text("🔄 Rabochiy Balonlar").row()
  .text("📍 Manzil").text("📞 Aloqa")
  .resized();

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

  if (isAdmin(userId)) {
    await ctx.reply(
      `🎉 Salom, ${name}!\n\n` +
      `📊 Admin paneliga xush kelibsiz!\n` +
      `Quyidagi tugmalar orqali boshqaring:`,
      { reply_markup: adminMenu }
    );
  } else {
    const shopName = await getSetting("shop_name");
    const workingHours = await getSetting("working_hours");
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
  const kb = isAdmin(ctx.from.id) ? adminMenu : userMenu;
  await ctx.reply("Bosh menyu", { reply_markup: kb });
});

// ==================== USER PANEL ====================

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
      "😔 Hozircha mavjud balonlar yo'q.\n\n" +
      "📞 Buyurtma uchun biz bilan bog'laning!",
      { reply_markup: userMenu }
    );
    return;
  }

  const kb = new InlineKeyboard();
  for (const r of result.rows) {
    kb.text(`🛞 ${r.razmer}`, `user_size_${r.razmer}`).row();
  }

  await ctx.reply(
    "🛞 <b>Mavjud razmerlar</b>\n\n" +
    "O'zingizga kerakli razmerni tanlang:\n\n" +
    "💡 <i>Har bir razmerda turli brendlar mavjud</i>",
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
    await ctx.reply("Bu razmerda hozircha mavjud emas");
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
  text += `📞 Buyurtma uchun: "Aloqa" tugmasini bosing\n`;
  text += `📍 Yetkazib berish mavjud!`;

  const kb = new InlineKeyboard()
    .text("📞 Bog'lanish", "user_contact")
    .text("📍 Manzil", "user_location");

  await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });
});

// Rabochiy Balonlar
bot.hears("🔄 Rabochiy Balonlar", async (ctx) => {
  const result = await pool.query(
    "SELECT * FROM rabochiy_balon WHERE soni > 0 ORDER BY razmer"
  );

  if (result.rows.length === 0) {
    await ctx.reply(
      "🔄 <b>Rabochiy balonlar</b>\n\n" +
      "😔 Hozircha rabochiy balonlar yo'q.\n\n" +
      "💡 Tez-tez tekshirib turing - yangilari qo'shiladi!",
      { reply_markup: userMenu, parse_mode: "HTML" }
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
  text += `📞 Sotib olish uchun bog'laning!`;

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

// ==================== ADMIN PANEL ====================

// KIRIM
bot.hears("📦 Kirim", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const kb = new InlineKeyboard()
    .text("➕ Yangi kirim", "kirim_new").row()
    .text("📋 Royxat", "kirim_list");

  await ctx.reply("📦 <b>Kirim bo'limi</b>\n\nTovar qabul qilish:", 
    { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("kirim_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "kirim_size";
  ctx.session.data = {};
  await ctx.reply("📏 Razmer tanlang:", { reply_markup: await sizeKeyboard("ks") });
});

bot.callbackQuery(/^ks_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.razmer = ctx.match[1];
  ctx.session.step = "kirim_brand";
  await ctx.reply(
    `📏 Razmer: <b>${ctx.match[1]}</b>\n\n🏷 Brend tanlang:`,
    { reply_markup: await brandKeyboard("kb"), parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^kb_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.balon_turi = ctx.match[1];
  ctx.session.step = "kirim_soni";
  await ctx.reply(
    `📏 Razmer: <b>${ctx.session.data.razmer}</b>\n` +
    `🏷 Brend: <b>${ctx.match[1]}</b>\n\n` +
    `🔢 Nechta keldi?`,
    { reply_markup: backBtn, parse_mode: "HTML" }
  );
});

bot.callbackQuery("kirim_list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await pool.query("SELECT * FROM kirim ORDER BY id DESC LIMIT 15");

  if (result.rows.length === 0) {
    await ctx.reply("Kirim ro'yxati bo'sh");
    return;
  }

  let text = "<b>Kirimlar ro'yxati (so'ngi 15)</b>\n";
  text += "━━━━━━━━━━━━━━━━━━\n";
  for (const r of result.rows) {
    text += `ID: <b>${r.id}</b> | 🛞 ${r.razmer} | ${r.balon_turi}\n`;
    text += `📥 ${r.soni} ta | 💵 ${formatNumber(r.kelgan_narx)} | 💰 ${formatNumber(r.sotish_narx)}\n`;
    text += `📅 ${formatDate(r.sana)}\n\n`;
  }
  text += "━━━━━━━━━━━━━━━━━━\n";
  text += "Tahrirlash yoki o'chirish uchun ID ni kiriting yoki /ortga bosing.";
  const kb = new InlineKeyboard().text("✏️ Tahrirlash/O'chirish", "settings_editdel");
  await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("kirim_som", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.narx_type = "som";
  ctx.session.step = "kirim_kelgan_narx";
  await ctx.reply("💵 Kelgan narxini kiriting (1 dona, so'm):", { reply_markup: backBtn });
});

bot.callbackQuery("kirim_dollar", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.narx_type = "dollar";
  ctx.session.step = "kirim_kelgan_narx";
  await ctx.reply("💵 Kelgan narxini kiriting (1 dona, $):", { reply_markup: backBtn });
});

bot.callbackQuery("kirim_sotish_som", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.sotish_type = "som";
  ctx.session.step = "kirim_sotish_narx";
  await ctx.reply("💰 Sotish narxini kiriting (1 dona, so'm):", { reply_markup: backBtn });
});

bot.callbackQuery("kirim_sotish_dollar", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.sotish_type = "dollar";
  ctx.session.step = "kirim_sotish_narx";
  await ctx.reply("💰 Sotish narxini kiriting (1 dona, $):", { reply_markup: backBtn });
});

// CHIQIM
bot.hears("💰 Chiqim", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const kb = new InlineKeyboard()
    .text("➕ Yangi sotuv", "chiqim_new").row()
    .text("📋 Royxat", "chiqim_list");

  await ctx.reply("💰 <b>Sotish bo'limi</b>", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("chiqim_new", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "chiqim_size";
  ctx.session.data = {};
  await ctx.reply("📏 Razmer tanlang:", { reply_markup: await sizeKeyboard("cs") });
});

bot.callbackQuery(/^cs_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.data.razmer = ctx.match[1];
  ctx.session.step = "chiqim_brand";
  await ctx.reply(
    `📏 Razmer: <b>${ctx.match[1]}</b>\n\n🏷 Brend tanlang:`,
    { reply_markup: await brandKeyboard("cb"), parse_mode: "HTML" }
  );
});

bot.callbackQuery(/^cb_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const razmer = ctx.session.data.razmer;
  const balon_turi = ctx.match[1];
  ctx.session.data.balon_turi = balon_turi;

  const stock = await getStock(razmer, balon_turi);
  const sotishNarx = await getSotishNarx(razmer, balon_turi);
  
  ctx.session.step = "chiqim_soni";
  await ctx.reply(
    `📏 Razmer: <b>${razmer}</b>\n` +
    `🏷 Brend: <b>${balon_turi}</b>\n` +
    `📦 Omborda: <b>${stock} ta</b>\n` +
    `💵 Sotish narxi: <b>${formatNumber(sotishNarx)} so'm</b>\n\n` +
    `🔢 Nechta sotildi?`,
    { reply_markup: backBtn, parse_mode: "HTML" }
  );
});

bot.callbackQuery("chiqim_list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await pool.query("SELECT * FROM chiqim ORDER BY id DESC LIMIT 15");

  if (result.rows.length === 0) {
    await ctx.reply("Sotuvlar ro'yxati bo'sh");
    return;
  }

  let text = "<b>Sotuvlar ro'yxati (so'ngi 15)</b>\n";
  text += "━━━━━━━━━━━━━━━━━━\n";
  for (const r of result.rows) {
    text += `ID: <b>${r.id}</b> | 🛞 ${r.razmer} | ${r.balon_turi}\n`;
    text += `📤 ${r.sotildi} ta = ${formatNumber(r.umumiy_qiymat)} so'm\n`;
    text += `📈 Foyda: ${formatNumber(r.foyda)} so'm\n`;
    text += `📅 ${formatDate(r.sana)}\n\n`;
  }
  text += "━━━━━━━━━━━━━━━━━━\n";
  text += "Tahrirlash yoki o'chirish uchun ID ni kiriting yoki /ortga bosing.";
  const kb = new InlineKeyboard().text("✏️ Tahrirlash/O'chirish", "settings_editdel");
  await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });
});

// XISOBOT
bot.hears("📊 Xisobot", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const kb = new InlineKeyboard()
    .text("📊 Umumiy", "rep_all").text("📅 Bugungi", "rep_today").row()
    .text("📦 Qoldiq", "rep_stock").row()
    .text("📥 Excel (kunlik)", "rep_excel_day").text("📥 Excel (haftalik)", "rep_excel_week").row()
    .text("📥 Excel (oylik)", "rep_excel_month").text("📥 Excel (yillik)", "rep_excel_year").row()
    .text("📥 Excel (umumiy)", "rep_excel_all");

  await ctx.reply("📊 <b>Xisobot turi tanlang:</b>", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("rep_all", async (ctx) => {
  await ctx.answerCallbackQuery();

  const result = await pool.query(`
    SELECT k.razmer, k.balon_turi,
      COALESCE(SUM(k.soni), 0) as kirdi,
      ROUND(AVG(k.kelgan_narx)) as tan_narxi
    FROM kirim k
    GROUP BY k.razmer, k.balon_turi
    ORDER BY k.razmer
  `);

  if (result.rows.length === 0) {
    await ctx.reply("Ma'lumot yo'q");
    return;
  }

  let text = "📊 <b>UMUMIY XISOBOT</b>\n━━━━━━━━━━━━━━━━━━\n\n";
  let totalFoyda = 0;

  for (const r of result.rows) {
    const sotildi = await pool.query(
      "SELECT COALESCE(SUM(sotildi), 0) as s, COALESCE(SUM(foyda), 0) as f FROM chiqim WHERE razmer = $1 AND balon_turi = $2",
      [r.razmer, r.balon_turi]
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
  const result = await pool.query("SELECT * FROM chiqim WHERE sana = CURRENT_DATE");

  if (result.rows.length === 0) {
    await ctx.reply("📅 Bugun sotuvlar yo'q");
    return;
  }

  let text = "📅 <b>BUGUNGI SOTUVLAR</b>\n━━━━━━━━━━━━━━━━━━\n\n";
  let total = 0, foyda = 0;

  for (const r of result.rows) {
    text += `🛞 ${r.razmer} | ${r.balon_turi}\n`;
    text += `📤 ${r.sotildi} ta = ${formatNumber(r.umumiy_qiymat)} so'm\n`;
    text += `📈 Foyda: ${formatNumber(r.foyda)} so'm\n\n`;
    total += Number(r.umumiy_qiymat);
    foyda += Number(r.foyda);
  }

  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `💵 Jami: ${formatNumber(total)} | Foyda: ${formatNumber(foyda)}`;
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.callbackQuery("rep_stock", async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await pool.query(`
    SELECT razmer, balon_turi, SUM(soni) as kirdi FROM kirim 
    GROUP BY razmer, balon_turi ORDER BY razmer
  `);

  if (result.rows.length === 0) {
    await ctx.reply("Ma'lumot yo'q");
    return;
  }

  let text = "📦 <b>QOLDIQ</b>\n━━━━━━━━━━━━━━━━━━\n\n";
  let jamiSum = 0;

  for (const r of result.rows) {
    const qoldi = await getStock(r.razmer, r.balon_turi);
    if (qoldi > 0) {
      const sotishNarx = await getSotishNarx(r.razmer, r.balon_turi);
      const jami = qoldi * sotishNarx;
      jamiSum += jami;
      text += `🛞 ${r.razmer} | ${r.balon_turi}: <b>${qoldi} ta</b>\n`;
      text += `💰 Jami: <b>${formatNumber(jami)} so'm</b>\n\n`;
    }
  }

  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `💰 <b>Ombordagi jami tovar: ${formatNumber(jamiSum)} so'm</b>`;

  await ctx.reply(text || "Ombor bo'sh", { parse_mode: "HTML" });
});

bot.callbackQuery("rep_excel", async (ctx) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Xisobot");
    sheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Nomi', key: 'name', width: 32 }
    ];
    sheet.addRow({id: 1, name: 'Test'});
    const buffer = await workbook.xlsx.writeBuffer();
    if (!buffer || buffer.byteLength === 0) {
      await ctx.reply("Excel fayl yaratilmadi yoki bo'sh!");
      return;
    }
    const dateStr = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(
      new InputFile(buffer, `xisobot_${dateStr}.xlsx`)
    );
  } catch (error) {
    console.error("Xatolik yuz berdi:", error);
    await ctx.reply("Faylni yuborishda xatolik yuz berdi.");
  }
});

async function generateExcelAndSend(ctx, type) {
    try {
        let query = "";
        let params = [];
        if (type === 'day') {
            query = "SELECT * FROM chiqim WHERE sana = $1";
            params = [new Date().toISOString().slice(0, 10)];
        } else {
            query = "SELECT * FROM chiqim";
            params = [];
        }
        const result = await pool.query(query, params);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Xisobot");
        sheet.columns = [
            { header: 'ID', key: 'id' },
            { header: 'Razmer', key: 'razmer' },
            { header: 'Brend', key: 'balon_turi' },
            { header: 'Sotildi', key: 'sotildi' },
            { header: 'Umumiy', key: 'umumiy_qiymat' },
            { header: 'Foyda', key: 'foyda' },
            { header: 'Sana', key: 'sana' }
        ];
        result.rows.forEach(row => sheet.addRow(row));
        const buffer = await workbook.xlsx.writeBuffer();
        const fileName = `xisobot_${type}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        await ctx.replyWithDocument(new InputFile(buffer, fileName));
    } catch (error) {
        console.error("Bot error:", error);
        await ctx.reply("Xatolik yuz berdi: " + error.message);
    }
}

bot.callbackQuery("rep_excel_day", async (ctx) => {
  await ctx.answerCallbackQuery();
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  await generateExcelAndSend(ctx, "day");
});

bot.callbackQuery("rep_excel_week", async (ctx) => {
  await ctx.answerCallbackQuery();
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 6);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = today.toISOString().slice(0, 10);
  await generateExcelAndSend(ctx, "week");
});

bot.callbackQuery("rep_excel_month", async (ctx) => {
  await ctx.answerCallbackQuery();
  const today = new Date();
  const month = today.getMonth() + 1;
  const year = today.getFullYear();
  await generateExcelAndSend(ctx, "month");
});

bot.callbackQuery("rep_excel_year", async (ctx) => {
  await ctx.answerCallbackQuery();
  const year = new Date().getFullYear();
  await generateExcelAndSend(ctx, "year");
});

bot.callbackQuery("rep_excel_all", async (ctx) => {
  await ctx.answerCallbackQuery();
  await generateExcelAndSend(ctx, "all");
});

// ROYXAT
bot.hears("📋 Royxat", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const kb = new InlineKeyboard()
    .text("📏 Razmerlar", "list_sizes").text("🏷 Brendlar", "list_brands").row()
    .text("➕ Razmer", "add_size").text("➕ Brend", "add_brand");

  await ctx.reply("📋 <b>Ro'yxatlar</b>", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("list_sizes", async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await pool.query("SELECT * FROM sizes ORDER BY id");

  if (result.rows.length === 0) {
    await ctx.reply("Razmerlar ro'yxati bo'sh");
    return;
  }

  for (const r of result.rows) {
    const kb = new InlineKeyboard()
      .text("✏️ Tahrirlash", `size_edit_${r.id}`)
      .text("🗑 O'chirish", `size_del_${r.id}`);
    await ctx.reply(
      `📏 <b>${r.id}</b>. ${r.name}`,
      { reply_markup: kb, parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery("list_brands", async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await pool.query("SELECT * FROM brands ORDER BY id");

  if (result.rows.length === 0) {
    await ctx.reply("Brendlar ro'yxati bo'sh");
    return;
  }

  for (const r of result.rows) {
    const kb = new InlineKeyboard()
      .text("✏️ Tahrirlash", `brand_edit_${r.id}`)
      .text("🗑 O'chirish", `brand_del_${r.id}`);
    await ctx.reply(
      `🏷 <b>${r.id}</b>. ${r.name}`,
      { reply_markup: kb, parse_mode: "HTML" }
    );
  }
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
  if (!isAdmin(ctx.from.id)) return;

  const kb = new InlineKeyboard()
    .text("➕ Qo'shish", "rab_add").row()
    .text("📋 Ro'yxat", "rab_list");

  await ctx.reply("🔄 <b>Rabochiy balonlar</b>", { reply_markup: kb, parse_mode: "HTML" });
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
  const result = await pool.query("SELECT * FROM rabochiy_balon WHERE soni > 0 ORDER BY razmer");

  if (result.rows.length === 0) {
    await ctx.reply("Rabochiy balonlar yo'q");
    return;
  }

  for (const r of result.rows) {
    const kb = new InlineKeyboard()
      .text("✏️ Tahrirlash", `rab_edit_${r.id}`)
      .text("🗑 O'chirish", `rab_del_${r.id}`);
    const holat = r.holat === 'yaxshi' ? '✅' : r.holat === 'orta' ? '🟡' : '🔴';
    await ctx.reply(
      `${r.id}. 🛞 ${r.razmer} | ${r.balon_turi}\n` +
      `   ${r.soni} ta x ${formatNumber(r.narx)} so'm ${holat}`,
      { reply_markup: kb, parse_mode: "HTML" }
    );
  }
});

// OLINISH KERAK
bot.hears("🛒 Olinish kerak", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const kb = new InlineKeyboard()
    .text("➕ Qo'shish", "ol_add").row()
    .text("📋 Ro'yxat", "ol_list").row()
    .text("🗑 O'chirish", "ol_delete");

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

bot.callbackQuery("ol_list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const result = await pool.query("SELECT * FROM olinish_kerak ORDER BY id");

  if (result.rows.length === 0) {
    await ctx.reply("Ro'yxat bo'sh");
    return;
  }

  for (const r of result.rows) {
    const kb = new InlineKeyboard()
      .text("✏️ Tahrirlash", `ol_edit_${r.id}`)
      .text("🗑 O'chirish", `ol_del_${r.id}`);
    await ctx.reply(
      `🛒 <b>${r.id}</b>. ${r.razmer} | ${r.balon_turi} - ${r.soni} ta`,
      { reply_markup: kb, parse_mode: "HTML" }
    );
  }
});

bot.callbackQuery(/^ol_del_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = parseInt(ctx.match[1]);
  await pool.query("DELETE FROM olinish_kerak WHERE id = $1", [id]);
  await ctx.reply(`🗑 O'chirildi (ID: ${id})`);
});

bot.callbackQuery(/^ol_edit_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = parseInt(ctx.match[1]);
  ctx.session.step = "ol_edit";
  ctx.session.data.edit_id = id;
  await ctx.reply("Yangi sonni kiriting:", { reply_markup: backBtn });
});

// Universal message:text handler (faqat bitta bo'lishi kerak)
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const step = ctx.session.step;

  // O'chirish/tahrirlash uchun ID kiritish
  if (step === "editdel_id") {
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
    const kb = new InlineKeyboard().text("🗑 O'chirish", "editdel_del").text("✏️ Tahrirlash", "editdel_edit");
    await ctx.reply(`ID: ${id} (${table}) uchun amal tanlang:`, { reply_markup: kb });
    return;
  }
  // Tahrirlash uchun maydon nomi kiritish
  if (step === "editdel_field") {
    ctx.session.data.editdel_field = text.trim();
    ctx.session.step = "editdel_value";
    await ctx.reply("Yangi qiymatni kiriting:", { reply_markup: backBtn });
    return;
  }
  // Tahrirlash uchun yangi qiymat kiritish
  if (step === "editdel_value") {
    const table = ctx.session.data.editdel_table;
    const id = ctx.session.data.editdel_id;
    const field = ctx.session.data.editdel_field;
    let value = text;
    if (["soni","sotildi","umumiy_qiymat","foyda","rabochiy_olindi","rabochiy_narxi","kelgan_narx","sotish_narx","narx"].includes(field)) {
      value = parseInt(text);
      if (isNaN(value)) {
        await ctx.reply("❌ To'g'ri son kiriting");
        return;
      }
    } else if (field === "sana") {
      if (!/\d{4}-\d{2}-\d{2}/.test(text)) {
        await ctx.reply("❌ Sana YYYY-MM-DD formatda bo'lishi kerak");
        return;
      }
    }
    try {
      const res = await pool.query(`UPDATE ${table} SET ${field} = $1 WHERE id = $2`, [value, id]);
      if (res.rowCount === 0) {
        await ctx.reply("❌ Bunday ID topilmadi yoki tahrirlanmadi");
      } else {
        await ctx.reply(`✏️ Tahrirlandi: ${table} (ID: ${id})`, { reply_markup: adminMenu });
      }
    } catch (e) {
      await ctx.reply("❌ Tahrirlashda xatolik: " + e.message);
    }
    ctx.session.step = null;
    ctx.session.data = {};
    return;
  }
  // ...qolgan step-lar (kirim, chiqim, rabochiy va boshqalar)...
});

// Rabochiy holat callbacks
bot.callbackQuery(/^rh_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const holat = ctx.match[1];
  const { razmer, balon_turi, soni, narx } = ctx.session.data;

  await pool.query(
    "INSERT INTO rabochiy_balon (razmer, balon_turi, soni, narx, holat) VALUES ($1, $2, $3, $4, $5)",
    [razmer, balon_turi, soni, narx, holat]
  );

  ctx.session.step = null;
  ctx.session.data = {};
  
  const holatText = holat === 'yaxshi' ? '✅ Yaxshi' : holat === 'orta' ? '🟡 O\'rta' : '🔴 Past';
  await ctx.reply(
    `✅ <b>Rabochiy balon qo'shildi!</b>\n\n` +
    `🛞 ${razmer} | ${balon_turi}\n` +
    `📦 ${soni} ta x ${formatNumber(narx)} so'm\n` +
    `📊 Holat: ${holatText}`,
    { reply_markup: adminMenu, parse_mode: "HTML" }
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
  await saveChiqim(ctx);
});

async function saveChiqim(ctx) {
  const { razmer, balon_turi, sotildi, umumiy, rabochiy_soni, rabochiy_narx } = ctx.session.data;

  const kelganNarx = await getKelganNarx(razmer, balon_turi);
  const foyda = umumiy - (kelganNarx * sotildi);

  await pool.query(
    `INSERT INTO chiqim (razmer, balon_turi, sotildi, umumiy_qiymat, foyda, rabochiy_olindi, rabochiy_narxi) 
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [razmer, balon_turi, sotildi, umumiy, foyda, rabochiy_soni || 0, rabochiy_narx || 0]
  );

  // Rabochiy omborda saqlash
  if (rabochiy_soni > 0) {
    await pool.query(
      "INSERT INTO rabochiy_balon (razmer, balon_turi, soni, narx) VALUES ($1, $2, $3, $4)",
      [razmer, balon_turi, rabochiy_soni, rabochiy_narx]
    );
  }

  ctx.session.step = null;
  ctx.session.data = {};

  await ctx.reply(
    `✅ <b>Sotuv saqlandi!</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
    `🛞 ${razmer} | ${balon_turi}\n` +
    `📤 ${sotildi} ta = ${formatNumber(umumiy)} so'm\n` +
    `📈 Foyda: ${formatNumber(foyda)} so'm` +
    (rabochiy_soni > 0 ? `\n🔄 Rabochiy: ${rabochiy_soni} ta` : ""),
    { reply_markup: adminMenu, parse_mode: "HTML" }
  );
}

bot.hears("⚙️ Sozlamalar", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const kb = new InlineKeyboard()
    .text("🔑 Ma'lumot o'chirish/tahrirlash", "settings_editdel");
  await ctx.reply("⚙️ <b>Sozlamalar bo'limi</b>", { reply_markup: kb, parse_mode: "HTML" });
});

bot.callbackQuery("settings_editdel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "editdel_table";
  const kb = new InlineKeyboard()
    .text("Kirim", "editdel_kirim").text("Chiqim", "editdel_chiqim").row()
    .text("Rabochiy", "editdel_rab").text("Olinish kerak", "editdel_ol").row()
    .text("Razmer", "editdel_size").text("Brend", "editdel_brand");
  await ctx.reply("Qaysi jadvaldan o'chirish/tahrirlash?", { reply_markup: kb });
});

bot.callbackQuery(/^editdel_(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tableMap = {
    kirim: "kirim",
    chiqim: "chiqim",
    rab: "rabochiy_balon",
    ol: "olinish_kerak",
    size: "sizes",
    brand: "brands"
  };
  const t = ctx.match[1];
  ctx.session.data.editdel_table = tableMap[t];
  ctx.session.step = "editdel_id";
  await ctx.reply("ID ni kiriting (o'chirish/tahrirlash uchun):", { reply_markup: backBtn });
});

bot.callbackQuery("editdel_del", async (ctx) => {
  await ctx.answerCallbackQuery();
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
  ctx.session.step = "editdel_field";
  await ctx.reply("Qaysi maydonni tahrirlaysiz? (maydon nomini yozing, masalan: soni, narx, sana, name, ...)", { reply_markup: backBtn });
});

// ==================== START BOT ====================
async function main() {
  await ensureDollarHistoryTable();
  await initDB();
  console.log("🚀 Bot ishga tushdi...");
  const res = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  console.log("Mavjud jadvallar:", res.rows.map(r => r.table_name));
  bot.start();
}

main().catch(console.error);
