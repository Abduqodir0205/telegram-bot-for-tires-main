const { Composer } = require('grammy');
const tireService = require('../../services/tireService');
const keyboards = require('../../utils/keyboards');
const { formatCurrency, isValidTireSize, translateCondition } = require('../../utils/helpers');
const logger = require('../../utils/logger');

const usedTires = new Composer();

// Session state for used tire operations
const usedTireState = new Map();

// List used tires
usedTires.hears('📋 Rabochiy ro\'yxati', async (ctx) => {
  try {
    const result = await tireService.getAllUsedTires(ctx.shopId);
    
    if (result.tires.length === 0) {
      return ctx.reply('📭 Rabochiy balonlar ro\'yxati bo\'sh', {
        reply_markup: keyboards.adminUsedTireMenu,
      });
    }

    let message = '♻️ *Rabochiy balonlar ro\'yxati:*\n\n';
    
    for (const tire of result.tires) {
      const status = tire.quantity > 0 ? '✅' : '❌';
      const sellPrice = tire.priceSell ? formatCurrency(tire.priceSell) : 'Belgilanmagan';
      message += `${status} *${tire.size}* - ${translateCondition(tire.condition)}\n`;
      message += `   💵 Olingan: ${formatCurrency(tire.priceBuy)} → 💰 Sotish: ${sellPrice}\n`;
      message += `   📦 Soni: ${tire.quantity} dona\n\n`;
    }

    if (result.pages > 1) {
      message += `\n📄 Sahifa: ${result.currentPage}/${result.pages}`;
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: result.pages > 1 
        ? keyboards.createPaginationKeyboard(result.currentPage, result.pages, 'used_tires')
        : undefined,
    });
  } catch (error) {
    logger.error('Error listing used tires:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Add used tire (accept)
usedTires.hears('➕ Rabochiy qabul qilish', async (ctx) => {
  usedTireState.set(ctx.from.id, { step: 'size' });
  await ctx.reply('📏 Razmerini kiriting (masalan: 205/55 R16):\n\n❌ Bekor qilish uchun /cancel', {
    reply_markup: keyboards.cancelButton,
  });
});

// Handle used tire addition steps
usedTires.on('message:text', async (ctx, next) => {
  const state = usedTireState.get(ctx.from.id);
  
  if (!state) {
    return next();
  }

  const text = ctx.message.text;

  if (text === '❌ Bekor qilish' || text === '/cancel') {
    usedTireState.delete(ctx.from.id);
    return ctx.reply('❌ Bekor qilindi', { reply_markup: keyboards.adminUsedTireMenu });
  }

  switch (state.step) {
    case 'size':
      if (!isValidTireSize(text)) {
        return ctx.reply('⚠️ Noto\'g\'ri razmer formati. Masalan: 205/55 R16');
      }
      state.size = text.toUpperCase();
      state.step = 'condition';
      await ctx.reply('📊 Balon holatini tanlang:', {
        reply_markup: keyboards.createConditionKeyboard(),
      });
      break;

    case 'priceBuy':
      const priceBuy = parseFloat(text);
      if (isNaN(priceBuy) || priceBuy <= 0) {
        return ctx.reply('⚠️ Noto\'g\'ri narx. Raqam kiriting:');
      }
      state.priceBuy = priceBuy;
      state.step = 'quantity';
      await ctx.reply('📦 Sonini kiriting:');
      break;

    case 'quantity':
      const quantity = parseInt(text);
      if (isNaN(quantity) || quantity < 0) {
        return ctx.reply('⚠️ Noto\'g\'ri son. Raqam kiriting:');
      }
      state.quantity = quantity;

      try {
        const usedTire = await tireService.createUsedTire({
          shopId: ctx.shopId,
          size: state.size,
          condition: state.condition,
          priceBuy: state.priceBuy,
          quantity: state.quantity,
        });

        usedTireState.delete(ctx.from.id);

        await ctx.reply(
          `✅ Rabochiy balon qabul qilindi!\n\n` +
          `📏 Razmer: ${usedTire.size}\n` +
          `📊 Holati: ${translateCondition(usedTire.condition)}\n` +
          `💵 Olingan narx: ${formatCurrency(usedTire.priceBuy)}\n` +
          `📦 Soni: ${usedTire.quantity} dona`,
          { reply_markup: keyboards.adminUsedTireMenu }
        );
      } catch (error) {
        usedTireState.delete(ctx.from.id);
        if (error.code === 'P2002') {
          await ctx.reply('⚠️ Bu razmer va holat allaqachon mavjud! Mavjudiga qo\'shish uchun tahrirlang.', {
            reply_markup: keyboards.adminUsedTireMenu,
          });
        } else {
          logger.error('Error adding used tire:', error);
          await ctx.reply('❌ Xatolik yuz berdi', { reply_markup: keyboards.adminUsedTireMenu });
        }
      }
      break;

    default:
      return next();
  }

  usedTireState.set(ctx.from.id, state);
});

// Condition selection callback
usedTires.callbackQuery(/^condition_(.+)$/, async (ctx) => {
  const condition = ctx.match[1];
  const state = usedTireState.get(ctx.from.id);
  
  if (!state || state.step !== 'condition') {
    return ctx.answerCallbackQuery('⚠️ Sessiya tugagan');
  }

  state.condition = condition;
  state.step = 'priceBuy';
  usedTireState.set(ctx.from.id, state);

  await ctx.editMessageText(`📊 Holat: ${translateCondition(condition)}\n\n💵 Sotib olingan narxni kiriting ($):`);
  await ctx.answerCallbackQuery();
});

// Set sell price for used tires
usedTires.hears('💵 Narx belgilash', async (ctx) => {
  const tires = await tireService.getAllUsedTires(ctx.shopId);
  
  if (tires.tires.length === 0) {
    return ctx.reply('📭 Rabochiy balonlar yo\'q');
  }

  let message = '💵 Sotish narxi belgilash uchun tanlang:\n\n';
  
  const buttons = tires.tires.map((tire, index) => ({
    text: `${tire.size} - ${translateCondition(tire.condition)}`,
    callback_data: `set_price_${tire.id}`,
  }));

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }

  await ctx.reply(message, {
    reply_markup: { inline_keyboard: keyboard },
  });
});

// Handle price setting callback
usedTires.callbackQuery(/^set_price_(\d+)$/, async (ctx) => {
  const tireId = parseInt(ctx.match[1]);
  const tire = await tireService.getUsedTireById(tireId);
  
  if (!tire) {
    return ctx.answerCallbackQuery('⚠️ Balon topilmadi');
  }

  usedTireState.set(ctx.from.id, { 
    step: 'setPrice', 
    tireId,
    tire 
  });

  await ctx.editMessageText(
    `📏 Razmer: ${tire.size}\n` +
    `📊 Holati: ${translateCondition(tire.condition)}\n` +
    `💵 Hozirgi sotish narxi: ${tire.priceSell ? formatCurrency(tire.priceSell) : 'Belgilanmagan'}\n\n` +
    `💰 Yangi sotish narxini kiriting ($):`
  );
  await ctx.answerCallbackQuery();
});

// Handle set price input
usedTires.on('message:text', async (ctx, next) => {
  const state = usedTireState.get(ctx.from.id);
  
  if (!state || state.step !== 'setPrice') {
    return next();
  }

  const text = ctx.message.text;

  if (text === '❌ Bekor qilish' || text === '/cancel') {
    usedTireState.delete(ctx.from.id);
    return ctx.reply('❌ Bekor qilindi', { reply_markup: keyboards.adminUsedTireMenu });
  }

  const priceSell = parseFloat(text);
  if (isNaN(priceSell) || priceSell <= 0) {
    return ctx.reply('⚠️ Noto\'g\'ri narx. Raqam kiriting:');
  }

  try {
    await tireService.updateUsedTire(state.tireId, { priceSell });
    usedTireState.delete(ctx.from.id);

    await ctx.reply(
      `✅ Sotish narxi belgilandi!\n\n` +
      `📏 Razmer: ${state.tire.size}\n` +
      `💰 Yangi narx: ${formatCurrency(priceSell)}`,
      { reply_markup: keyboards.adminUsedTireMenu }
    );
  } catch (error) {
    logger.error('Error setting price:', error);
    await ctx.reply('❌ Xatolik yuz berdi', { reply_markup: keyboards.adminUsedTireMenu });
  }
});

// Pagination callback
usedTires.callbackQuery(/^used_tires_page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  const result = await tireService.getAllUsedTires(ctx.shopId, page);

  let message = '♻️ *Rabochiy balonlar ro\'yxati:*\n\n';
  
  for (const tire of result.tires) {
    const status = tire.quantity > 0 ? '✅' : '❌';
    const sellPrice = tire.priceSell ? formatCurrency(tire.priceSell) : 'Belgilanmagan';
    message += `${status} *${tire.size}* - ${translateCondition(tire.condition)}\n`;
    message += `   💵 Olingan: ${formatCurrency(tire.priceBuy)} → 💰 Sotish: ${sellPrice}\n`;
    message += `   📦 Soni: ${tire.quantity} dona\n\n`;
  }

  message += `\n📄 Sahifa: ${result.currentPage}/${result.pages}`;

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboards.createPaginationKeyboard(result.currentPage, result.pages, 'used_tires'),
  });
  await ctx.answerCallbackQuery();
});

module.exports = usedTires;
