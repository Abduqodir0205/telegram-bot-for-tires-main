const XLSX = require('xlsx');
const { prisma } = require('../utils/database');
const { 
  formatCurrency, 
  formatShortDate, 
  translateCondition, 
  translateItemType,
  getStartOfMonth,
  getEndOfMonth 
} = require('../utils/helpers');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

class ExcelService {
  constructor() {
    this.exportDir = path.join(process.cwd(), 'exports');
    // Create exports directory if it doesn't exist
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }
  }

  async generateInventoryReport(shopId) {
    try {
      const [newTires, usedTires, shop] = await Promise.all([
        prisma.tire.findMany({ where: { shopId } }),
        prisma.usedTire.findMany({ where: { shopId } }),
        prisma.shop.findUnique({ where: { id: shopId } }),
      ]);

      const workbook = XLSX.utils.book_new();

      // New Tires Sheet
      const newTiresData = [
        ['YANGI BALONLAR - ' + (shop?.name || 'SherShina')],
        ['Sana: ' + formatShortDate(new Date())],
        [],
        ['#', 'Brand', 'Razmer', 'Kelish narxi ($)', 'Sotish narxi ($)', 'Soni', 'Umumiy qiymat ($)'],
      ];

      let totalNewCount = 0;
      let totalNewValue = 0;

      newTires.forEach((tire, index) => {
        const value = tire.quantity * tire.priceSell;
        totalNewCount += tire.quantity;
        totalNewValue += value;
        newTiresData.push([
          index + 1,
          tire.brand,
          tire.size,
          tire.priceBuy,
          tire.priceSell,
          tire.quantity,
          value,
        ]);
      });

      newTiresData.push([]);
      newTiresData.push(['', '', '', '', 'JAMI:', totalNewCount, totalNewValue]);

      const newTiresSheet = XLSX.utils.aoa_to_sheet(newTiresData);
      XLSX.utils.book_append_sheet(workbook, newTiresSheet, 'Yangi balonlar');

      // Used Tires Sheet
      const usedTiresData = [
        ['RABOCHIY BALONLAR - ' + (shop?.name || 'SherShina')],
        ['Sana: ' + formatShortDate(new Date())],
        [],
        ['#', 'Razmer', 'Holati', 'Olingan narx ($)', 'Sotish narxi ($)', 'Soni', 'Olingan qiymat ($)', 'Sotish qiymati ($)'],
      ];

      let totalUsedCount = 0;
      let totalUsedBuyValue = 0;
      let totalUsedSellValue = 0;

      usedTires.forEach((tire, index) => {
        const buyValue = tire.quantity * tire.priceBuy;
        const sellValue = tire.quantity * (tire.priceSell || 0);
        totalUsedCount += tire.quantity;
        totalUsedBuyValue += buyValue;
        totalUsedSellValue += sellValue;
        usedTiresData.push([
          index + 1,
          tire.size,
          translateCondition(tire.condition),
          tire.priceBuy,
          tire.priceSell || 'Belgilanmagan',
          tire.quantity,
          buyValue,
          sellValue,
        ]);
      });

      usedTiresData.push([]);
      usedTiresData.push(['', '', '', '', 'JAMI:', totalUsedCount, totalUsedBuyValue, totalUsedSellValue]);

      const usedTiresSheet = XLSX.utils.aoa_to_sheet(usedTiresData);
      XLSX.utils.book_append_sheet(workbook, usedTiresSheet, 'Rabochiy balonlar');

      // Summary Sheet
      const summaryData = [
        ['SKLAD XULOSASI - ' + (shop?.name || 'SherShina')],
        ['Sana: ' + formatShortDate(new Date())],
        [],
        ['Ko\'rsatkich', 'Yangi balonlar', 'Rabochiy balonlar', 'Jami'],
        ['Soni (dona)', totalNewCount, totalUsedCount, totalNewCount + totalUsedCount],
        ['Sarflangan ($)', newTires.reduce((sum, t) => sum + t.quantity * t.priceBuy, 0), totalUsedBuyValue, newTires.reduce((sum, t) => sum + t.quantity * t.priceBuy, 0) + totalUsedBuyValue],
        ['Sotish qiymati ($)', totalNewValue, totalUsedSellValue, totalNewValue + totalUsedSellValue],
        ['Kutilayotgan foyda ($)', totalNewValue - newTires.reduce((sum, t) => sum + t.quantity * t.priceBuy, 0), totalUsedSellValue - totalUsedBuyValue, (totalNewValue + totalUsedSellValue) - (newTires.reduce((sum, t) => sum + t.quantity * t.priceBuy, 0) + totalUsedBuyValue)],
      ];

      const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Xulosa');

      // Write file
      const filename = `sklad_${shopId}_${Date.now()}.xlsx`;
      const filepath = path.join(this.exportDir, filename);
      XLSX.writeFile(workbook, filepath);

      return filepath;
    } catch (error) {
      logger.error('Error generating inventory report:', error);
      throw error;
    }
  }

  async generateSalesReport(shopId, startDate, endDate) {
    try {
      const [sales, shop] = await Promise.all([
        prisma.sale.findMany({
          where: {
            shopId,
            createdAt: {
              gte: startDate || getStartOfMonth(),
              lte: endDate || getEndOfMonth(),
            },
          },
          include: {
            tire: true,
            usedTire: true,
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.shop.findUnique({ where: { id: shopId } }),
      ]);

      const workbook = XLSX.utils.book_new();

      // Sales Sheet
      const salesData = [
        ['SOTUVLAR HISOBOTI - ' + (shop?.name || 'SherShina')],
        ['Davr: ' + formatShortDate(startDate || getStartOfMonth()) + ' - ' + formatShortDate(endDate || getEndOfMonth())],
        [],
        ['#', 'Sana', 'Turi', 'Balon', 'Soni', 'Narxi ($)', 'Jami ($)'],
      ];

      let totalNewSales = 0;
      let totalUsedSales = 0;
      let totalNewRevenue = 0;
      let totalUsedRevenue = 0;

      sales.forEach((sale, index) => {
        const tireInfo = sale.tire 
          ? `${sale.tire.brand} ${sale.tire.size}`
          : `${sale.usedTire?.size || 'N/A'} (${translateCondition(sale.usedTire?.condition)})`;
        
        const price = sale.totalPrice / sale.quantity;
        
        salesData.push([
          index + 1,
          formatShortDate(sale.createdAt),
          translateItemType(sale.itemType),
          tireInfo,
          sale.quantity,
          price,
          sale.totalPrice,
        ]);

        if (sale.itemType === 'NEW') {
          totalNewSales += sale.quantity;
          totalNewRevenue += sale.totalPrice;
        } else {
          totalUsedSales += sale.quantity;
          totalUsedRevenue += sale.totalPrice;
        }
      });

      salesData.push([]);
      salesData.push(['', '', '', 'JAMI YANGI:', totalNewSales, '', totalNewRevenue]);
      salesData.push(['', '', '', 'JAMI RABOCHIY:', totalUsedSales, '', totalUsedRevenue]);
      salesData.push(['', '', '', 'UMUMIY JAMI:', totalNewSales + totalUsedSales, '', totalNewRevenue + totalUsedRevenue]);

      const salesSheet = XLSX.utils.aoa_to_sheet(salesData);
      XLSX.utils.book_append_sheet(workbook, salesSheet, 'Sotuvlar');

      // Write file
      const filename = `sotuvlar_${shopId}_${Date.now()}.xlsx`;
      const filepath = path.join(this.exportDir, filename);
      XLSX.writeFile(workbook, filepath);

      return filepath;
    } catch (error) {
      logger.error('Error generating sales report:', error);
      throw error;
    }
  }

  async generateFullReport(shopId) {
    try {
      const [newTires, usedTires, sales, warehouseLogs, shop] = await Promise.all([
        prisma.tire.findMany({ where: { shopId } }),
        prisma.usedTire.findMany({ where: { shopId } }),
        prisma.sale.findMany({
          where: { shopId },
          include: { tire: true, usedTire: true },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        prisma.warehouseLog.findMany({
          include: { tire: true, usedTire: true },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        prisma.shop.findUnique({ where: { id: shopId } }),
      ]);

      const workbook = XLSX.utils.book_new();

      // Inventory Sheet
      const inventoryData = [
        ['SKLAD HISOBOTI - ' + (shop?.name || 'SherShina')],
        ['Yaratilgan: ' + formatShortDate(new Date())],
        [],
        ['YANGI BALONLAR'],
        ['Brand', 'Razmer', 'Kelish ($)', 'Sotish ($)', 'Soni', 'Qiymat ($)'],
      ];

      newTires.forEach(tire => {
        inventoryData.push([
          tire.brand,
          tire.size,
          tire.priceBuy,
          tire.priceSell,
          tire.quantity,
          tire.quantity * tire.priceSell,
        ]);
      });

      inventoryData.push([]);
      inventoryData.push(['RABOCHIY BALONLAR']);
      inventoryData.push(['Razmer', 'Holati', 'Olingan ($)', 'Sotish ($)', 'Soni', 'Qiymat ($)']);

      usedTires.forEach(tire => {
        inventoryData.push([
          tire.size,
          translateCondition(tire.condition),
          tire.priceBuy,
          tire.priceSell || 'N/A',
          tire.quantity,
          tire.quantity * (tire.priceSell || 0),
        ]);
      });

      const inventorySheet = XLSX.utils.aoa_to_sheet(inventoryData);
      XLSX.utils.book_append_sheet(workbook, inventorySheet, 'Sklad');

      // Sales Sheet
      const salesData = [
        ['SOTUVLAR TARIXI'],
        [],
        ['Sana', 'Turi', 'Balon', 'Soni', 'Jami ($)'],
      ];

      sales.forEach(sale => {
        const tireInfo = sale.tire 
          ? `${sale.tire.brand} ${sale.tire.size}`
          : `${sale.usedTire?.size || 'N/A'}`;
        salesData.push([
          formatShortDate(sale.createdAt),
          translateItemType(sale.itemType),
          tireInfo,
          sale.quantity,
          sale.totalPrice,
        ]);
      });

      const salesSheet = XLSX.utils.aoa_to_sheet(salesData);
      XLSX.utils.book_append_sheet(workbook, salesSheet, 'Sotuvlar');

      // Warehouse Logs Sheet
      const logsData = [
        ['OMBOR HARAKATLARI'],
        [],
        ['Sana', 'Harakat', 'Turi', 'Balon', 'Soni', 'Narx ($)'],
      ];

      warehouseLogs.forEach(log => {
        const tireInfo = log.tire 
          ? `${log.tire.brand} ${log.tire.size}`
          : `${log.usedTire?.size || 'N/A'}`;
        logsData.push([
          formatShortDate(log.createdAt),
          log.logType === 'IN' ? 'Kirim' : 'Chiqim',
          translateItemType(log.itemType),
          tireInfo,
          log.quantity,
          log.price,
        ]);
      });

      const logsSheet = XLSX.utils.aoa_to_sheet(logsData);
      XLSX.utils.book_append_sheet(workbook, logsSheet, 'Harakatlar');

      // Write file
      const filename = `toliq_hisobot_${shopId}_${Date.now()}.xlsx`;
      const filepath = path.join(this.exportDir, filename);
      XLSX.writeFile(workbook, filepath);

      return filepath;
    } catch (error) {
      logger.error('Error generating full report:', error);
      throw error;
    }
  }

  // Clean up old export files
  cleanupOldFiles(maxAge = 24 * 60 * 60 * 1000) {
    try {
      const files = fs.readdirSync(this.exportDir);
      const now = Date.now();

      for (const file of files) {
        const filepath = path.join(this.exportDir, file);
        const stats = fs.statSync(filepath);
        
        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(filepath);
          logger.debug(`Deleted old export file: ${file}`);
        }
      }
    } catch (error) {
      logger.error('Error cleaning up old files:', error);
    }
  }
}

module.exports = new ExcelService();
