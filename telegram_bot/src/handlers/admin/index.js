const { Composer } = require('grammy');
const { requireAdmin } = require('../../middlewares/auth');
const keyboards = require('../../utils/keyboards');
const tireHandlers = require('./tires');
const usedTireHandlers = require('./usedTires');
const warehouseHandlers = require('./warehouse');
const salesHandlers = require('./sales');
const reportsHandlers = require('./reports');
const settingsHandlers = require('./settings');

const admin = new Composer();

// Apply admin middleware to all handlers
admin.use(requireAdmin);

// Register sub-handlers
admin.use(tireHandlers);
admin.use(usedTireHandlers);
admin.use(warehouseHandlers);
admin.use(salesHandlers);
admin.use(reportsHandlers);
admin.use(settingsHandlers);

// Admin menu navigation
admin.hears('🛞 Yangi balonlar', async (ctx) => {
  await ctx.reply('🛞 Yangi balonlar bo\'limi:', {
    reply_markup: keyboards.adminTireMenu,
  });
});

admin.hears('♻️ Rabochiy balonlar', async (ctx) => {
  await ctx.reply('♻️ Rabochiy balonlar bo\'limi:', {
    reply_markup: keyboards.adminUsedTireMenu,
  });
});

admin.hears('📦 Sklad', async (ctx) => {
  await ctx.reply('📦 Sklad bo\'limi:', {
    reply_markup: keyboards.adminWarehouseMenu,
  });
});

admin.hears('💰 Sotish', async (ctx) => {
  await ctx.reply('💰 Sotish bo\'limi:', {
    reply_markup: keyboards.adminSalesMenu,
  });
});

admin.hears('📊 Hisobotlar', async (ctx) => {
  await ctx.reply('📊 Hisobotlar bo\'limi:', {
    reply_markup: keyboards.adminReportsMenu,
  });
});

admin.hears('⚙️ Sozlamalar', async (ctx) => {
  await ctx.reply('⚙️ Sozlamalar bo\'limi:', {
    reply_markup: keyboards.adminSettingsMenu,
  });
});

admin.hears('🔙 Orqaga', async (ctx) => {
  await ctx.reply(`🏠 Bosh menyu - ${ctx.shop?.name || 'SherShina'}`, {
    reply_markup: keyboards.adminMainMenu,
  });
});

module.exports = admin;
