const { Composer, InlineKeyboard } = require('grammy');
const tireService = require('../../services/tireService');
const salesService = require('../../services/salesService');
const keyboards = require('../../utils/keyboards');
const { formatCurrency, formatDate, translateCondition, translateItemType } = require('../../utils/helpers');
const logger = require('../../utils/logger');

const sales = new Composer();

// Session state for sales
const salesState = new Map();

// Sell new tire
sales.hears('🛞 Yangi balon sotish', async (ctx) => {
  try {
    const tires = await tireService.getAvailableTires(ctx.shopId);
    
    if (tires.length === 0) {
      return ctx.reply('📭 Sotish uchun yangi balonlar yo\'q', {
        reply_markup: keyboards.adminSalesMenu,
      });
    }

    let message = '🛞 *Sotish uchun balonni tanlang:*\n\n';
    
    const keyboard = new InlineKeyboard();
    
    for (const tire of tires) {
      message += `• ${tire.brand} ${tire.size} - ${formatCurrency(tire.priceSell)} (${tire.quantity} dona)\n`;
      keyboard.text(`${tire.brand} ${tire.size}`, `sell_new_${tire.id}`).row();
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error('Error listing tires for sale:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Handle new tire selection for sale
sales.callbackQuery(/^sell_new_(\d+)$/, async (ctx) => {
  const tireId = parseInt(ctx.match[1]);
  const tire = await tireService.getTireById(tireId);
  
  if (!tire || tire.quantity === 0) {
    return ctx.answerCallbackQuery('⚠️ Balon mavjud emas');
  }

  salesState.set(ctx.from.id, {
    step: 'quantity',
    type: 'NEW',
    tireId: tire.id,
    tire,
    maxQuantity: tire.quantity,
    price: tire.priceSell,
  });

  await ctx.editMessageText(
    `🛞 *${tire.brand} ${tire.size}*\n\n` +
    `💰 Narxi: ${formatCurrency(tire.priceSell)}\n` +
    `📦 Mavjud: ${tire.quantity} dona\n\n` +
    `📝 Nechta sotmoqchisiz?`,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Sell used tire
sales.hears('♻️ Rabochiy sotish', async (ctx) => {
  try {
    const tires = await tireService.getAvailableUsedTires(ctx.shopId);
    
    if (tires.length === 0) {
      return ctx.reply('📭 Sotish uchun rabochiy balonlar yo\'q', {
        reply_markup: keyboards.adminSalesMenu,
      });
    }

    let message = '♻️ *Sotish uchun rabochiy balonni tanlang:*\n\n';
    
    const keyboard = new InlineKeyboard();
    
    for (const tire of tires) {
      message += `• ${tire.size} (${translateCondition(tire.condition)}) - ${formatCurrency(tire.priceSell)} (${tire.quantity} dona)\n`;
      keyboard.text(`${tire.size} - ${translateCondition(tire.condition)}`, `sell_used_${tire.id}`).row();
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error('Error listing used tires for sale:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Handle used tire selection for sale
sales.callbackQuery(/^sell_used_(\d+)$/, async (ctx) => {
  const tireId = parseInt(ctx.match[1]);
  const tire = await tireService.getUsedTireById(tireId);
  
  if (!tire || tire.quantity === 0) {
    return ctx.answerCallbackQuery('⚠️ Balon mavjud emas');
  }

  if (!tire.priceSell) {
    return ctx.answerCallbackQuery('⚠️ Sotish narxi belgilanmagan');
  }

  salesState.set(ctx.from.id, {
    step: 'quantity',
    type: 'USED',
    usedTireId: tire.id,
    tire,
    maxQuantity: tire.quantity,
    price: tire.priceSell,
  });

  await ctx.editMessageText(
    `♻️ *${tire.size}* - ${translateCondition(tire.condition)}\n\n` +
    `💰 Narxi: ${formatCurrency(tire.priceSell)}\n` +
    `📦 Mavjud: ${tire.quantity} dona\n\n` +
    `📝 Nechta sotmoqchisiz?`,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCallbackQuery();
});

// Handle quantity input for sales
sales.on('message:text', async (ctx, next) => {
  const state = salesState.get(ctx.from.id);
  
  if (!state || state.step !== 'quantity') {
    return next();
  }

  const text = ctx.message.text;

  if (text === '❌ Bekor qilish' || text === '/cancel') {
    salesState.delete(ctx.from.id);
    return ctx.reply('❌ Bekor qilindi', { reply_markup: keyboards.adminSalesMenu });
  }

  const quantity = parseInt(text);
  
  if (isNaN(quantity) || quantity <= 0) {
    return ctx.reply('⚠️ Noto\'g\'ri son. Musbat raqam kiriting:');
  }

  if (quantity > state.maxQuantity) {
    return ctx.reply(`⚠️ Faqat ${state.maxQuantity} dona mavjud. Kamroq kiriting:`);
  }

  const totalPrice = quantity * state.price;

  try {
    const sale = await salesService.createSale({
      itemType: state.type,
      tireId: state.tireId,
      usedTireId: state.usedTireId,
      quantity,
      totalPrice,
      adminId: ctx.admin.id,
      shopId: ctx.shopId,
    });

    salesState.delete(ctx.from.id);

    const tireInfo = state.type === 'NEW' 
      ? `${state.tire.brand} ${state.tire.size}`
      : `${state.tire.size} - ${translateCondition(state.tire.condition)}`;

    await ctx.reply(
      `✅ *Sotildi!*\n\n` +
      `${state.type === 'NEW' ? '🛞' : '♻️'} Balon: ${tireInfo}\n` +
      `📦 Soni: ${quantity} dona\n` +
      `💰 Jami: ${formatCurrency(totalPrice)}\n` +
      `📅 Sana: ${formatDate(sale.createdAt)}`,
      { 
        parse_mode: 'Markdown',
        reply_markup: keyboards.adminSalesMenu 
      }
    );
  } catch (error) {
    salesState.delete(ctx.from.id);
    logger.error('Error creating sale:', error);
    await ctx.reply('❌ Xatolik yuz berdi', { reply_markup: keyboards.adminSalesMenu });
  }
});

// Sales history
sales.hears('📜 Sotuvlar tarixi', async (ctx) => {
  try {
    const result = await salesService.getSales(ctx.shopId, { limit: 10 });
    
    if (result.sales.length === 0) {
      return ctx.reply('📭 Sotuvlar tarixi bo\'sh', {
        reply_markup: keyboards.adminSalesMenu,
      });
    }

    let message = '📜 *Oxirgi sotuvlar:*\n\n';
    
    for (const sale of result.sales) {
      const typeIcon = sale.itemType === 'NEW' ? '🛞' : '♻️';
      const tireInfo = sale.kirim 
        ? `${sale.kirim.brand} ${sale.kirim.size}`
        : `${sale.usedTire.size} - ${translateCondition(sale.usedTire.condition)}`;
      
      message += `${typeIcon} *${tireInfo}*\n`;
      message += `   📦 ${sale.quantity} dona × 💰 ${formatCurrency(sale.totalPrice)}\n`;
      message += `   📅 ${formatDate(sale.createdAt)}\n\n`;
    }

    if (result.pages > 1) {
      message += `\n📄 Sahifa: ${result.currentPage}/${result.pages}`;
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: result.pages > 1 
        ? keyboards.createPaginationKeyboard(result.currentPage, result.pages, 'sales')
        : keyboards.adminSalesMenu,
    });
  } catch (error) {
    logger.error('Error getting sales history:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Sales pagination
sales.callbackQuery(/^sales_page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  const result = await salesService.getSales(ctx.shopId, { page, limit: 10 });

  let message = '📜 *Sotuvlar tarixi:*\n\n';
  
  for (const sale of result.sales) {
    const typeIcon = sale.itemType === 'NEW' ? '🛞' : '♻️';
    const tireInfo = sale.kirim 
      ? `${sale.kirim.brand} ${sale.kirim.size}`
      : `${sale.usedTire.size} - ${translateCondition(sale.usedTire.condition)}`;
    
    message += `${typeIcon} *${tireInfo}*\n`;
    message += `   📦 ${sale.quantity} dona × 💰 ${formatCurrency(sale.totalPrice)}\n`;
    message += `   📅 ${formatDate(sale.createdAt)}\n\n`;
  }

  message += `\n📄 Sahifa: ${result.currentPage}/${result.pages}`;

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboards.createPaginationKeyboard(result.currentPage, result.pages, 'sales'),
  });
  await ctx.answerCallbackQuery();
});

module.exports = sales;
