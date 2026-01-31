const { Composer, InputFile } = require('grammy');
const excelService = require('../../services/excelService');
const keyboards = require('../../utils/keyboards');
const { getStartOfMonth, getEndOfMonth } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const fs = require('fs');

const excel = new Composer();

// Excel download handler
excel.hears('📥 Excel yuklab olish', async (ctx) => {
  try {
    await ctx.reply(
      '📥 *Excel hisobotni tanlang:*\n\n' +
      '1️⃣ Sklad hisoboti - barcha balonlar\n' +
      '2️⃣ Sotuvlar hisoboti - bu oylik sotuvlar\n' +
      '3️⃣ To\'liq hisobot - barchasi',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📦 Sklad', callback_data: 'excel_inventory' },
              { text: '💰 Sotuvlar', callback_data: 'excel_sales' },
            ],
            [
              { text: '📊 To\'liq hisobot', callback_data: 'excel_full' },
            ],
          ],
        },
      }
    );
  } catch (error) {
    logger.error('Error showing excel menu:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Inventory report
excel.callbackQuery('excel_inventory', async (ctx) => {
  try {
    await ctx.answerCallbackQuery('⏳ Hisobot tayyorlanmoqda...');
    await ctx.editMessageText('⏳ Sklad hisoboti tayyorlanmoqda...');

    const filepath = await excelService.generateInventoryReport(ctx.shopId);
    
    await ctx.replyWithDocument(new InputFile(filepath), {
      caption: '📦 Sklad hisoboti tayyor!',
    });

    // Clean up file after sending
    setTimeout(() => {
      try {
        fs.unlinkSync(filepath);
      } catch (e) {
        logger.debug('Could not delete temp file:', e.message);
      }
    }, 5000);

    await ctx.reply('📥 Yana hisobot kerakmi?', {
      reply_markup: keyboards.adminMainMenu,
    });
  } catch (error) {
    logger.error('Error generating inventory report:', error);
    await ctx.reply('❌ Hisobot yaratishda xatolik yuz berdi', {
      reply_markup: keyboards.adminMainMenu,
    });
  }
});

// Sales report
excel.callbackQuery('excel_sales', async (ctx) => {
  try {
    await ctx.answerCallbackQuery('⏳ Hisobot tayyorlanmoqda...');
    await ctx.editMessageText('⏳ Sotuvlar hisoboti tayyorlanmoqda...');

    const startDate = getStartOfMonth();
    const endDate = getEndOfMonth();
    
    const filepath = await excelService.generateSalesReport(ctx.shopId, startDate, endDate);
    
    await ctx.replyWithDocument(new InputFile(filepath), {
      caption: '💰 Sotuvlar hisoboti tayyor!\n📅 Bu oylik ma\'lumotlar',
    });

    // Clean up file after sending
    setTimeout(() => {
      try {
        fs.unlinkSync(filepath);
      } catch (e) {
        logger.debug('Could not delete temp file:', e.message);
      }
    }, 5000);

    await ctx.reply('📥 Yana hisobot kerakmi?', {
      reply_markup: keyboards.adminMainMenu,
    });
  } catch (error) {
    logger.error('Error generating sales report:', error);
    await ctx.reply('❌ Hisobot yaratishda xatolik yuz berdi', {
      reply_markup: keyboards.adminMainMenu,
    });
  }
});

// Full report
excel.callbackQuery('excel_full', async (ctx) => {
  try {
    await ctx.answerCallbackQuery('⏳ Hisobot tayyorlanmoqda...');
    await ctx.editMessageText('⏳ To\'liq hisobot tayyorlanmoqda...\nBu biroz vaqt olishi mumkin.');

    const filepath = await excelService.generateFullReport(ctx.shopId);
    
    await ctx.replyWithDocument(new InputFile(filepath), {
      caption: '📊 To\'liq hisobot tayyor!\n\n' +
        '📦 Sklad\n' +
        '💰 Sotuvlar\n' +
        '📋 Ombor harakatlari',
    });

    // Clean up file after sending
    setTimeout(() => {
      try {
        fs.unlinkSync(filepath);
      } catch (e) {
        logger.debug('Could not delete temp file:', e.message);
      }
    }, 5000);

    await ctx.reply('📥 Yana hisobot kerakmi?', {
      reply_markup: keyboards.adminMainMenu,
    });
  } catch (error) {
    logger.error('Error generating full report:', error);
    await ctx.reply('❌ Hisobot yaratishda xatolik yuz berdi', {
      reply_markup: keyboards.adminMainMenu,
    });
  }
});

module.exports = excel;
