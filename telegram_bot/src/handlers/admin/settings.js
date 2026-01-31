const { Composer } = require('grammy');
const { prisma } = require('../../utils/database');
const keyboards = require('../../utils/keyboards');
const logger = require('../../utils/logger');

const settings = new Composer();

// Session state for settings
const settingsState = new Map();

// Change location
settings.hears('📍 Lokatsiyani o\'zgartirish', async (ctx) => {
  settingsState.set(ctx.from.id, { step: 'location' });
  await ctx.reply(
    '📍 Yangi manzilni kiriting:\n\n' +
    'Masalan: Toshkent shahri, Yunusobod tumani, Amir Temur ko\'chasi 123\n\n' +
    '❌ Bekor qilish uchun /cancel',
    { reply_markup: keyboards.cancelButton }
  );
});

// Change phone
settings.hears('📞 Telefon o\'zgartirish', async (ctx) => {
  settingsState.set(ctx.from.id, { step: 'phone' });
  await ctx.reply(
    '📞 Yangi telefon raqamini kiriting:\n\n' +
    'Masalan: +998 90 123 45 67\n\n' +
    '❌ Bekor qilish uchun /cancel',
    { reply_markup: keyboards.cancelButton }
  );
});

// Add admin
settings.hears('👤 Admin qo\'shish', async (ctx) => {
  settingsState.set(ctx.from.id, { step: 'addAdmin' });
  await ctx.reply(
    '👤 Yangi admin Telegram ID sini kiriting:\n\n' +
    '💡 ID ni bilish uchun @userinfobot ga yozing\n\n' +
    '❌ Bekor qilish uchun /cancel',
    { reply_markup: keyboards.cancelButton }
  );
});

// List admins
settings.hears('👥 Adminlar ro\'yxati', async (ctx) => {
  try {
    const admins = await prisma.admin.findMany({
      where: { shopId: ctx.shopId },
      include: {
        shop: true,
      },
    });

    if (admins.length === 0) {
      return ctx.reply('📭 Adminlar ro\'yxati bo\'sh', {
        reply_markup: keyboards.adminSettingsMenu,
      });
    }

    let message = '👥 *Adminlar ro\'yxati:*\n\n';
    
    for (let i = 0; i < admins.length; i++) {
      const admin = admins[i];
      // Try to get user info
      const user = await prisma.user.findUnique({
        where: { telegramId: admin.telegramId },
      });
      
      const name = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : 'Noma\'lum';
      const username = user?.username ? `@${user.username}` : '';
      
      message += `${i + 1}. *${name}* ${username}\n`;
      message += `   🆔 ID: \`${admin.telegramId}\`\n`;
      message += `   📅 Qo'shilgan: ${admin.createdAt.toLocaleDateString('uz-UZ')}\n\n`;
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminSettingsMenu,
    });
  } catch (error) {
    logger.error('Error listing admins:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Handle settings input
settings.on('message:text', async (ctx, next) => {
  const state = settingsState.get(ctx.from.id);
  
  if (!state) {
    return next();
  }

  const text = ctx.message.text;

  if (text === '❌ Bekor qilish' || text === '/cancel') {
    settingsState.delete(ctx.from.id);
    return ctx.reply('❌ Bekor qilindi', { reply_markup: keyboards.adminSettingsMenu });
  }

  switch (state.step) {
    case 'location':
      try {
        await prisma.shop.update({
          where: { id: ctx.shopId },
          data: { location: text },
        });
        
        settingsState.delete(ctx.from.id);
        await ctx.reply(
          `✅ Manzil yangilandi!\n\n📍 Yangi manzil: ${text}`,
          { reply_markup: keyboards.adminSettingsMenu }
        );
      } catch (error) {
        logger.error('Error updating location:', error);
        await ctx.reply('❌ Xatolik yuz berdi', { reply_markup: keyboards.adminSettingsMenu });
      }
      break;

    case 'phone':
      try {
        await prisma.shop.update({
          where: { id: ctx.shopId },
          data: { phone: text },
        });
        
        settingsState.delete(ctx.from.id);
        await ctx.reply(
          `✅ Telefon yangilandi!\n\n📞 Yangi raqam: ${text}`,
          { reply_markup: keyboards.adminSettingsMenu }
        );
      } catch (error) {
        logger.error('Error updating phone:', error);
        await ctx.reply('❌ Xatolik yuz berdi', { reply_markup: keyboards.adminSettingsMenu });
      }
      break;

    case 'addAdmin':
      const telegramId = parseInt(text);
      
      if (isNaN(telegramId)) {
        return ctx.reply('⚠️ Noto\'g\'ri ID. Raqam kiriting:');
      }

      try {
        // Check if already admin
        const existing = await prisma.admin.findUnique({
          where: { telegramId: BigInt(telegramId) },
        });

        if (existing) {
          settingsState.delete(ctx.from.id);
          return ctx.reply('⚠️ Bu foydalanuvchi allaqachon admin!', {
            reply_markup: keyboards.adminSettingsMenu,
          });
        }

        await prisma.admin.create({
          data: {
            telegramId: BigInt(telegramId),
            shopId: ctx.shopId,
          },
        });

        // Update user role if exists
        await prisma.user.updateMany({
          where: { telegramId: BigInt(telegramId) },
          data: { role: 'ADMIN' },
        });
        
        settingsState.delete(ctx.from.id);
        await ctx.reply(
          `✅ Admin qo'shildi!\n\n🆔 Telegram ID: ${telegramId}`,
          { reply_markup: keyboards.adminSettingsMenu }
        );
      } catch (error) {
        logger.error('Error adding admin:', error);
        await ctx.reply('❌ Xatolik yuz berdi', { reply_markup: keyboards.adminSettingsMenu });
      }
      break;

    default:
      return next();
  }
});

// Handle location sharing
settings.on('message:location', async (ctx, next) => {
  const state = settingsState.get(ctx.from.id);
  
  if (!state || state.step !== 'location') {
    return next();
  }

  try {
    const { latitude, longitude } = ctx.message.location;
    
    await prisma.shop.update({
      where: { id: ctx.shopId },
      data: { latitude, longitude },
    });
    
    settingsState.delete(ctx.from.id);
    await ctx.reply(
      `✅ Koordinatalar saqlandi!\n\n📍 Lat: ${latitude}\n📍 Lon: ${longitude}`,
      { reply_markup: keyboards.adminSettingsMenu }
    );
  } catch (error) {
    logger.error('Error updating coordinates:', error);
    await ctx.reply('❌ Xatolik yuz berdi', { reply_markup: keyboards.adminSettingsMenu });
  }
});

module.exports = settings;
