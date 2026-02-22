const { Composer } = require('grammy');
const salesService = require('../../services/salesService');
const warehouseService = require('../../services/warehouseService');
const keyboards = require('../../utils/keyboards');
const { 
  formatCurrency, 
  formatDate, 
  formatShortDate,
  getStartOfDay, 
  getEndOfDay,
  getStartOfMonth,
  getEndOfMonth 
} = require('../../utils/helpers');
const logger = require('../../utils/logger');

const reports = new Composer();

// Daily report
reports.hears('📅 Kunlik hisobot', async (ctx) => {
  try {
    const { sales, summary } = await salesService.getDailySales(ctx.shopId);
    
    const today = formatShortDate(new Date());
    
    let message = `📅 *Kunlik hisobot - ${today}*\n\n`;
    
    message += `🛞 *Yangi balonlar:*\n`;
    message += `   📦 Sotildi: ${summary.newTires.count} dona\n`;
    message += `   💰 Tushum: ${formatCurrency(summary.newTires.total)}\n\n`;
    
    message += `♻️ *Rabochiy balonlar:*\n`;
    message += `   📦 Sotildi: ${summary.usedTires.count} dona\n`;
    message += `   💰 Tushum: ${formatCurrency(summary.usedTires.total)}\n\n`;
    
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 *JAMI:*\n`;
    message += `   📦 Sotildi: ${summary.totalSales} dona\n`;
    message += `   💰 Tushum: ${formatCurrency(summary.totalRevenue)}`;

    if (sales.length > 0) {
      message += `\n\n📜 *Sotuvlar:*\n`;
      for (const sale of sales.slice(0, 5)) {
        const typeIcon = sale.itemType === 'NEW' ? '🛞' : '♻️';
        const tireInfo = sale.kirim 
          ? `${sale.kirim.brand} ${sale.kirim.size}`
          : `${sale.usedTire?.size || 'N/A'}`;
        message += `${typeIcon} ${tireInfo} - ${sale.quantity} dona - ${formatCurrency(sale.totalPrice)}\n`;
      }
      if (sales.length > 5) {
        message += `... va yana ${sales.length - 5} ta`;
      }
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminReportsMenu,
    });
  } catch (error) {
    logger.error('Error generating daily report:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Monthly report
reports.hears('📆 Oylik hisobot', async (ctx) => {
  try {
    const { sales } = await salesService.getMonthlySales(ctx.shopId);
    
    const monthNames = [
      'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
      'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'
    ];
    const currentMonth = monthNames[new Date().getMonth()];
    const currentYear = new Date().getFullYear();
    
    let message = `📆 *Oylik hisobot - ${currentMonth} ${currentYear}*\n\n`;
    
    let newTiresCount = 0;
    let newTiresTotal = 0;
    let usedTiresCount = 0;
    let usedTiresTotal = 0;

    for (const sale of sales) {
      if (sale.itemType === 'NEW') {
        newTiresCount = sale._sum.quantity || 0;
        newTiresTotal = sale._sum.totalPrice || 0;
      } else {
        usedTiresCount = sale._sum.quantity || 0;
        usedTiresTotal = sale._sum.totalPrice || 0;
      }
    }
    
    message += `🛞 *Yangi balonlar:*\n`;
    message += `   📦 Sotildi: ${newTiresCount} dona\n`;
    message += `   💰 Tushum: ${formatCurrency(newTiresTotal)}\n\n`;
    
    message += `♻️ *Rabochiy balonlar:*\n`;
    message += `   📦 Sotildi: ${usedTiresCount} dona\n`;
    message += `   💰 Tushum: ${formatCurrency(usedTiresTotal)}\n\n`;
    
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 *JAMI:*\n`;
    message += `   📦 Sotildi: ${newTiresCount + usedTiresCount} dona\n`;
    message += `   💰 Tushum: ${formatCurrency(newTiresTotal + usedTiresTotal)}`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminReportsMenu,
    });
  } catch (error) {
    logger.error('Error generating monthly report:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// General report
reports.hears('📈 Umumiy hisobot', async (ctx) => {
  try {
    const warehouseSummary = await warehouseService.getWarehouseSummary(ctx.shopId);
    const { sales: monthlySales } = await salesService.getMonthlySales(ctx.shopId);
    
    let monthlyRevenue = 0;
    for (const sale of monthlySales) {
      monthlyRevenue += sale._sum.totalPrice || 0;
    }

    const message = `📈 *Umumiy hisobot*\n\n` +
      `📦 *Sklad holati:*\n` +
      `   🛞 Yangi balonlar: ${warehouseSummary.newTires.count} dona\n` +
      `   ♻️ Rabochiy balonlar: ${warehouseSummary.usedTires.count} dona\n` +
      `   📊 Jami: ${warehouseSummary.total.count} dona\n\n` +
      `💰 *Sklad qiymati:*\n` +
      `   💵 Sarflangan: ${formatCurrency(warehouseSummary.total.buyValue)}\n` +
      `   💰 Kutilayotgan: ${formatCurrency(warehouseSummary.total.sellValue)}\n` +
      `   📈 Potensial foyda: ${formatCurrency(warehouseSummary.total.sellValue - warehouseSummary.total.buyValue)}\n\n` +
      `📆 *Bu oylik tushum:*\n` +
      `   💰 ${formatCurrency(monthlyRevenue)}`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminReportsMenu,
    });
  } catch (error) {
    logger.error('Error generating general report:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

// Income/Expense report
reports.hears('💵 Kirim/Chiqim', async (ctx) => {
  try {
    const startOfMonth = getStartOfMonth();
    const endOfMonth = getEndOfMonth();
    
    const report = await salesService.getIncomeExpense(ctx.shopId, startOfMonth, endOfMonth);
    
    const monthNames = [
      'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
      'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'
    ];
    const currentMonth = monthNames[new Date().getMonth()];
    
    const profitIcon = report.profit >= 0 ? '📈' : '📉';
    
    const message = `💵 *Kirim/Chiqim - ${currentMonth}*\n\n` +
      `📥 *KIRIM (Sotuvlar):*\n` +
      `   💰 ${formatCurrency(report.income)}\n\n` +
      `📤 *CHIQIM (Xaridlar):*\n` +
      `   🛞 Yangi balonlar: ${formatCurrency(report.expenses.newTires)}\n` +
      `   ♻️ Rabochiy balonlar: ${formatCurrency(report.expenses.usedTires)}\n` +
      `   📊 Jami: ${formatCurrency(report.expenses.total)}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${profitIcon} *FOYDA/ZARAR:*\n` +
      `   ${report.profit >= 0 ? '✅' : '❌'} ${formatCurrency(report.profit)}`;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboards.adminReportsMenu,
    });
  } catch (error) {
    logger.error('Error generating income/expense report:', error);
    await ctx.reply('❌ Xatolik yuz berdi');
  }
});

module.exports = reports;
