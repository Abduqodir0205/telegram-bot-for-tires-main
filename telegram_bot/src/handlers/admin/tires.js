const { Composer } = require('grammy');
const { conversations, createConversation } = require('@grammyjs/conversations');
const tireService = require('../../services/tireService');
const keyboards = require('../../utils/keyboards');
const { formatCurrency, isValidTireSize, translateCondition } = require('../../utils/helpers');
const logger = require('../../utils/logger');

const tires = new Composer();

// Session state for tire operations
const tireState = new Map();

// Add new tire conversation
async function addTireConversation(conversation, ctx) {
  await ctx.reply('🏭 Balon brendini kiriting (masalan: Michelin):');
  const brandMsg = await conversation.wait();
  const brand = brandMsg.message?.text;
  
  if (!brand || brand === '❌ Bekor qilish') {
    await ctx.reply('❌ Bekor qilindi', { reply_markup: keyboards.adminTireMenu });
    return;
  }

  await ctx.reply('📏 Razmerini kiriting (masalan: 205/55 R16):');
  const sizeMsg = await conversation.wait();
  const size = sizeMsg.message?.text;
  
  if (!size || size === '❌ Bekor qilish') {
    await ctx.reply('❌ Bekor qilindi', { reply_markup: keyboards.adminTireMenu });
    return;
  }

  if (!isValidTireSize(size)) {
    await ctx.reply('⚠️ Noto\'g\'ri razmer formati. Masalan: 205/55 R16', {
      reply_markup: keyboards.adminTireMenu,
    });
    return;
  }

  await ctx.reply('💵 Kelish narxini kiriting ($):');
  const priceBuyMsg = await conversation.wait();
  const priceBuy = parseFloat(priceBuyMsg.message?.text);
  
  if (isNaN(priceBuy) || priceBuy <= 0) {
    await ctx.reply('⚠️ Noto\'g\'ri narx', { reply_markup: keyboards.adminTireMenu });
    return;
  }

  await ctx.reply('💰 Sotish narxini kiriting ($):');
  const priceSellMsg = await conversation.wait();
  const priceSell = parseFloat(priceSellMsg.message?.text);
  
  if (isNaN(priceSell) || priceSell <= 0) {
    await ctx.reply('⚠️ Noto\'g\'ri narx', { reply_markup: keyboards.adminTireMenu });
    return;
  }

  await ctx.reply('📦 Sonini kiriting:');
  const quantityMsg = await conversation.wait();
  const quantity = parseInt(quantityMsg.message?.text);
  
  if (isNaN(quantity) || quantity < 0) {
    await ctx.reply('⚠️ Noto\'g\'ri son', { reply_markup: keyboards.adminTireMenu });
    return;
  }

  try {
    const tire = await tireService.createTire({
      shopId: ctx.shopId,
      brand,
      size: size.toUpperCase(),
      priceBuy,
      priceSell,
      quantity,
    });

    await ctx.reply(
      `✅ Balon qo'shildi!\n\n` +
      `🏭 Brand: ${tire.brand}\n` +
      `📏 Razmer: ${tire.size}\n` +
      `💵 Kelish: ${formatCurrency(tire.priceBuy)}\n` +
      `💰 Sotish: ${formatCurrency(tire.priceSell)}\n` +
      `📦 Soni: ${tire.quantity} dona`,
      { reply_markup: keyboards.adminTireMenu }
    );
  } catch (error) {
    if (error.code === 'P2002') {
      await ctx.reply('⚠️ Bu brand va razmer allaqachon mavjud!', {
        reply_markup: keyboards.adminTireMenu,
      });
    } else {
      logger.error('Error adding tire:', error);
      await ctx.reply('❌ Xatolik yuz berdi', { reply_markup: keyboards.adminTireMenu });
    }
  }
}

// List tires
tires.hears('📋 Balonlar ro\'yxati', async (ctx) => {
  try {
    const result = await tireService.getAllTires(ctx.shopId);
    
    if (result.tires.length === 0) {
      return ctx.reply('📭 Balonlar ro\'yxati bo\'sh', {
        reply_markup: keyboards.adminTireMenu,
      });
    }

    let message = '🛞 *Yangi balonlar ro\'yxati:*\n\n';
    
    for (const tire of result.tires) {
      const status = tire.quantity > 0 ? '✅' : '❌';
      message += `${status} *${tire.brand}* - ${tire.size}\n`;
      message += `   💵 ${formatCurrency(tire.priceBuy)} → 💰 ${formatCurrency(tire.priceSell)}\n`;
      message += `   📦 Soni: ${tire.quantity} dona\n\n`;
    }

    if (result.pages > 1) {
      message += `\n📄 Sahifa: ${result.currentPage}/${result.pages}`;
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: result.pages > 1 
        ? keyboards.createPaginationKeyboard(result.currentPage, result.pages, 'tires')
        : undefined,
    });
  } catch (error) {
    logger.error('Error listing tires:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Add tire button
tires.hears('➕ Balon qo\'shish', async (ctx) => {
  tireState.set(ctx.from.id, { step: 'brand' });
  await ctx.reply('🏭 Balon brendini kiriting (masalan: Michelin):\n\n❌ Bekor qilish uchun /cancel', {
    reply_markup: keyboards.cancelButton,
  });
});

// Handle tire addition steps
tires.on('message:text', async (ctx, next) => {
  const state = tireState.get(ctx.from.id);
  
  if (!state) {
    return next();
  }

  const text = ctx.message.text;

  if (text === '❌ Bekor qilish' || text === '/cancel') {
    tireState.delete(ctx.from.id);
    return ctx.reply('❌ Bekor qilindi', { reply_markup: keyboards.adminTireMenu });
  }

  switch (state.step) {
    case 'brand':
      state.brand = text;
      state.step = 'size';
      await ctx.reply('📏 Razmerini kiriting (masalan: 205/55 R16):');
      break;

    case 'size':
      if (!isValidTireSize(text)) {
        return ctx.reply('⚠️ Noto\'g\'ri razmer formati. Masalan: 205/55 R16');
      }
      state.size = text.toUpperCase();
      state.step = 'priceBuy';
      await ctx.reply('💵 Kelish narxini kiriting ($):');
      break;

    case 'priceBuy':
      const priceBuy = parseFloat(text);
      if (isNaN(priceBuy) || priceBuy <= 0) {
        return ctx.reply('⚠️ Noto\'g\'ri narx. Raqam kiriting:');
      }
      state.priceBuy = priceBuy;
      state.step = 'priceSell';
      await ctx.reply('💰 Sotish narxini kiriting ($):');
      break;

    case 'priceSell':
      const priceSell = parseFloat(text);
      if (isNaN(priceSell) || priceSell <= 0) {
        return ctx.reply('⚠️ Noto\'g\'ri narx. Raqam kiriting:');
      }
      state.priceSell = priceSell;
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
        const tire = await tireService.createTire({
          shopId: ctx.shopId,
          brand: state.brand,
          size: state.size,
          priceBuy: state.priceBuy,
          priceSell: state.priceSell,
          quantity: state.quantity,
        });

        tireState.delete(ctx.from.id);

        await ctx.reply(
          `✅ Balon qo'shildi!\n\n` +
          `🏭 Brand: ${tire.brand}\n` +
          `📏 Razmer: ${tire.size}\n` +
          `💵 Kelish: ${formatCurrency(tire.priceBuy)}\n` +
          `💰 Sotish: ${formatCurrency(tire.priceSell)}\n` +
          `📦 Soni: ${tire.quantity} dona`,
          { reply_markup: keyboards.adminTireMenu }
        );
      } catch (error) {
        tireState.delete(ctx.from.id);
        if (error.code === 'P2002') {
          await ctx.reply('⚠️ Bu brand va razmer allaqachon mavjud!', {
            reply_markup: keyboards.adminTireMenu,
          });
        } else {
          logger.error('Error adding tire:', error);
          await ctx.reply('❌ Xatolik yuz berdi', { reply_markup: keyboards.adminTireMenu });
        }
      }
      break;

    default:
      return next();
  }

  tireState.set(ctx.from.id, state);
});

// Edit tire
tires.hears('✏️ Balon tahrirlash', async (ctx) => {
  const tires = await tireService.getAvailableTires(ctx.shopId);
  
  if (tires.length === 0) {
    return ctx.reply('📭 Tahrirlash uchun balonlar yo\'q');
  }

  let message = '✏️ Tahrirlash uchun balonni tanlang:\n\n';
  
  const buttons = tires.map((tire, index) => ({
    text: `${index + 1}. ${tire.brand} ${tire.size}`,
    callback_data: `edit_tire_${tire.id}`,
  }));

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }

  await ctx.reply(message, {
    reply_markup: { inline_keyboard: keyboard },
  });
});

// Pagination callback
tires.callbackQuery(/^tires_page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  const result = await tireService.getAllTires(ctx.shopId, page);

  let message = '🛞 *Yangi balonlar ro\'yxati:*\n\n';
  
  for (const tire of result.tires) {
    const status = tire.quantity > 0 ? '✅' : '❌';
    message += `${status} *${tire.brand}* - ${tire.size}\n`;
    message += `   💵 ${formatCurrency(tire.priceBuy)} → 💰 ${formatCurrency(tire.priceSell)}\n`;
    message += `   📦 Soni: ${tire.quantity} dona\n\n`;
  }

  message += `\n📄 Sahifa: ${result.currentPage}/${result.pages}`;

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: keyboards.createPaginationKeyboard(result.currentPage, result.pages, 'tires'),
  });
  await ctx.answerCallbackQuery();
});

module.exports = tires;
