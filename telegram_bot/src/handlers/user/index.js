const { Composer } = require('grammy');
const tireService = require('../../services/tireService');
const keyboards = require('../../utils/keyboards');
const { formatCurrency, translateCondition } = require('../../utils/helpers');
const logger = require('../../utils/logger');

const user = new Composer();

// New tires list for users
user.hears('🛞 Yangi balonlar', async (ctx) => {
  // Skip if admin (admin handler will catch this)
  if (ctx.isAdmin) return;
  
  try {
    const tires = await tireService.getAvailableTires(ctx.shopId);
    
    if (tires.length === 0) {
      return ctx.reply(
        '📭 Hozircha yangi balonlar mavjud emas.\n\n' +
        'Tez orada yangi partiya keladi! 🚚',
        { reply_markup: keyboards.userMainMenu }
      );
    }

    let message = `🛞 *${ctx.shop?.name || 'SherShina'} - Yangi balonlar:*\n\n`;
    
    // Group by brand
    const byBrand = {};
    for (const tire of tires) {
      if (!byBrand[tire.brand]) {
        byBrand[tire.brand] = [];
      }
      byBrand[tire.brand].push(tire);
    }

    for (const [brand, brandTires] of Object.entries(byBrand)) {
      message += `🏭 *${brand}*\n`;
      for (const tire of brandTires) {
        message += `   📏 ${tire.size} - 💰 ${formatCurrency(tire.priceSell)}`;
        message += tire.quantity > 5 ? ' ✅\n' : ` (${tire.quantity} dona qoldi)\n`;
      }
      message += '\n';
    }

    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `📞 Buyurtma uchun: ${ctx.shop?.phone || 'Telefon raqamini so\'rang'}`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.userMainMenu,
    });
  } catch (error) {
    logger.error('Error listing tires for user:', error);
    await ctx.reply('❌ Xatolik yuz berdi. Iltimos, keyinroq urinib ko\'ring.');
  }
});

// Used tires list for users
user.hears('♻️ Rabochiy balonlar', async (ctx) => {
  // Skip if admin
  if (ctx.isAdmin) return;
  
  try {
    const tires = await tireService.getAvailableUsedTires(ctx.shopId);
    
    if (tires.length === 0) {
      return ctx.reply(
        '📭 Hozircha rabochiy balonlar mavjud emas.\n\n' +
        'Yangi partiya kelganda xabar beramiz! 📢',
        { reply_markup: keyboards.userMainMenu }
      );
    }

    let message = `♻️ *${ctx.shop?.name || 'SherShina'} - Rabochiy balonlar:*\n\n`;
    message += `💡 _Rabochiy balonlar - sifatli ishlatilgan balonlar_\n\n`;

    for (const tire of tires) {
      const conditionStars = {
        'EXCELLENT': '⭐⭐⭐⭐⭐',
        'GOOD': '⭐⭐⭐⭐',
        'FAIR': '⭐⭐⭐',
        'POOR': '⭐⭐',
      };
      
      message += `📏 *${tire.size}*\n`;
      message += `   Holati: ${translateCondition(tire.condition)} ${conditionStars[tire.condition] || ''}\n`;
      message += `   💰 Narxi: ${formatCurrency(tire.priceSell)}`;
      message += tire.quantity > 3 ? ' ✅\n' : ` (${tire.quantity} dona qoldi)\n`;
      message += '\n';
    }

    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `📞 Buyurtma uchun: ${ctx.shop?.phone || 'Telefon raqamini so\'rang'}`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.userMainMenu,
    });
  } catch (error) {
    logger.error('Error listing used tires for user:', error);
    await ctx.reply('❌ Xatolik yuz berdi. Iltimos, keyinroq urinib ko\'ring.');
  }
});

// Shop location
user.hears('📍 Manzil', async (ctx) => {
  if (ctx.isAdmin) return;
  
  const shop = ctx.shop;
  
  if (!shop) {
    return ctx.reply('⚠️ Do\'kon ma\'lumotlari topilmadi');
  }

  let message = `📍 *${shop.name} manzili:*\n\n`;
  message += `🏪 ${shop.location || 'Manzil ko\'rsatilmagan'}\n\n`;
  
  if (shop.latitude && shop.longitude) {
    message += `🗺 Xaritada ko'rish uchun quyidagi lokatsiyani bosing:`;
  }

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboards.userMainMenu,
  });

  // Send location if coordinates exist
  if (shop.latitude && shop.longitude) {
    await ctx.replyWithLocation(shop.latitude, shop.longitude);
  }
});

// Contact info
user.hears('📞 Aloqa', async (ctx) => {
  if (ctx.isAdmin) return;
  
  const shop = ctx.shop;
  
  if (!shop) {
    return ctx.reply('⚠️ Do\'kon ma\'lumotlari topilmadi');
  }

  const message = `📞 *${shop.name} aloqa ma'lumotlari:*\n\n` +
    `☎️ Telefon: ${shop.phone || 'Ko\'rsatilmagan'}\n\n` +
    `⏰ Ish vaqti: 09:00 - 18:00\n` +
    `📅 Dam olish: Yakshanba\n\n` +
    `💬 Savollar bo'lsa, qo'ng'iroq qiling yoki yozing!`;

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboards.userMainMenu,
  });

  // Send contact if phone exists
  if (shop.phone) {
    await ctx.replyWithContact(shop.phone, shop.name);
  }
});

// Shop info
user.hears('ℹ️ Ma\'lumot', async (ctx) => {
  if (ctx.isAdmin) return;
  
  const shop = ctx.shop;
  
  const message = `ℹ️ *${shop?.name || 'SherShina'} haqida:*\n\n` +
    `🛞 Biz avtomobil balonlari sohasida ishlaymiz:\n\n` +
    `✅ Yangi original balonlar\n` +
    `✅ Sifatli rabochiy balonlar\n` +
    `✅ Arzon narxlar\n` +
    `✅ Tez yetkazib berish\n` +
    `✅ Kafolat\n\n` +
    `🏷 *Bizning brendlar:*\n` +
    `Michelin, Bridgestone, Continental, Pirelli, Yokohama va boshqalar\n\n` +
    `💡 *Qanday balon tanlash kerak?*\n` +
    `Avtomobilingiz eshigi yoki texnik pasportida razmer ko'rsatilgan.\n` +
    `Masalan: 205/55 R16\n\n` +
    `📞 Bepul maslahat uchun qo'ng'iroq qiling!`;

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboards.userMainMenu,
  });
});

module.exports = user;
