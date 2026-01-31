const { Composer } = require('grammy');
const warehouseService = require('../../services/warehouseService');
const keyboards = require('../../utils/keyboards');
const { formatCurrency, translateCondition } = require('../../utils/helpers');
const logger = require('../../utils/logger');

const warehouse = new Composer();

// New tires warehouse
warehouse.hears('📦 Yangi balonlar skladi', async (ctx) => {
  try {
    const tires = await warehouseService.getNewTiresStock(ctx.shopId);
    
    if (tires.length === 0) {
      return ctx.reply('📭 Yangi balonlar skladi bo\'sh', {
        reply_markup: keyboards.adminWarehouseMenu,
      });
    }

    let message = '📦 *Yangi balonlar skladi:*\n\n';
    let totalCount = 0;
    let totalValue = 0;

    for (const tire of tires) {
      const status = tire.quantity > 0 ? '✅' : '❌';
      message += `${status} *${tire.brand}* - ${tire.size}\n`;
      message += `   📦 Soni: ${tire.quantity} dona\n`;
      message += `   💰 Qiymati: ${formatCurrency(tire.quantity * tire.priceSell)}\n\n`;
      
      totalCount += tire.quantity;
      totalValue += tire.quantity * tire.priceSell;
    }

    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 *Jami:* ${totalCount} dona\n`;
    message += `💰 *Umumiy qiymat:* ${formatCurrency(totalValue)}`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminWarehouseMenu,
    });
  } catch (error) {
    logger.error('Error getting new tires stock:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Used tires warehouse
warehouse.hears('♻️ Rabochiy balonlar skladi', async (ctx) => {
  try {
    const tires = await warehouseService.getUsedTiresStock(ctx.shopId);
    
    if (tires.length === 0) {
      return ctx.reply('📭 Rabochiy balonlar skladi bo\'sh', {
        reply_markup: keyboards.adminWarehouseMenu,
      });
    }

    let message = '♻️ *Rabochiy balonlar skladi:*\n\n';
    let totalCount = 0;
    let totalBuyValue = 0;
    let totalSellValue = 0;

    for (const tire of tires) {
      const status = tire.quantity > 0 ? '✅' : '❌';
      const sellPrice = tire.priceSell ? formatCurrency(tire.priceSell) : 'Belgilanmagan';
      message += `${status} *${tire.size}* - ${translateCondition(tire.condition)}\n`;
      message += `   📦 Soni: ${tire.quantity} dona\n`;
      message += `   💵 Olingan: ${formatCurrency(tire.priceBuy * tire.quantity)}\n`;
      if (tire.priceSell) {
        message += `   💰 Sotish: ${formatCurrency(tire.priceSell * tire.quantity)}\n`;
      }
      message += '\n';
      
      totalCount += tire.quantity;
      totalBuyValue += tire.quantity * tire.priceBuy;
      totalSellValue += tire.quantity * (tire.priceSell || 0);
    }

    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 *Jami:* ${totalCount} dona\n`;
    message += `💵 *Sarflangan:* ${formatCurrency(totalBuyValue)}\n`;
    message += `💰 *Kutilayotgan daromad:* ${formatCurrency(totalSellValue)}`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminWarehouseMenu,
    });
  } catch (error) {
    logger.error('Error getting used tires stock:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Out of stock items
warehouse.hears('⚠️ Tugagan balonlar', async (ctx) => {
  try {
    const { newTires, usedTires } = await warehouseService.getOutOfStock(ctx.shopId);
    
    if (newTires.length === 0 && usedTires.length === 0) {
      return ctx.reply('✅ Barcha balonlar mavjud!', {
        reply_markup: keyboards.adminWarehouseMenu,
      });
    }

    let message = '⚠️ *Tugagan balonlar:*\n\n';

    if (newTires.length > 0) {
      message += '*Yangi balonlar:*\n';
      for (const tire of newTires) {
        message += `❌ ${tire.brand} - ${tire.size}\n`;
      }
      message += '\n';
    }

    if (usedTires.length > 0) {
      message += '*Rabochiy balonlar:*\n';
      for (const tire of usedTires) {
        message += `❌ ${tire.size} - ${translateCondition(tire.condition)}\n`;
      }
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminWarehouseMenu,
    });
  } catch (error) {
    logger.error('Error getting out of stock:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Total warehouse value
warehouse.hears('💰 Umumiy qiymat', async (ctx) => {
  try {
    const summary = await warehouseService.getWarehouseSummary(ctx.shopId);

    const message = `💰 *Sklad umumiy qiymati:*\n\n` +
      `🛞 *Yangi balonlar:*\n` +
      `   📦 Soni: ${summary.newTires.count} dona (${summary.newTires.types} tur)\n` +
      `   💵 Kelish narxi: ${formatCurrency(summary.newTires.buyValue)}\n` +
      `   💰 Sotish narxi: ${formatCurrency(summary.newTires.sellValue)}\n\n` +
      `♻️ *Rabochiy balonlar:*\n` +
      `   📦 Soni: ${summary.usedTires.count} dona (${summary.usedTires.types} tur)\n` +
      `   💵 Olingan narx: ${formatCurrency(summary.usedTires.buyValue)}\n` +
      `   💰 Sotish narxi: ${formatCurrency(summary.usedTires.sellValue)}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📊 *JAMI:*\n` +
      `   📦 Balonlar: ${summary.total.count} dona\n` +
      `   💵 Sarflangan: ${formatCurrency(summary.total.buyValue)}\n` +
      `   💰 Kutilayotgan: ${formatCurrency(summary.total.sellValue)}\n` +
      `   📈 Foyda: ${formatCurrency(summary.total.sellValue - summary.total.buyValue)}`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminWarehouseMenu,
    });
  } catch (error) {
    logger.error('Error getting warehouse summary:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

module.exports = warehouse;
