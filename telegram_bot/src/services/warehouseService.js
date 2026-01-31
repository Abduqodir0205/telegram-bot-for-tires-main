const { prisma } = require('../utils/database');
const logger = require('../utils/logger');

class WarehouseService {
  async getWarehouseSummary(shopId) {
    try {
      // New tires summary
      const newTires = await prisma.tire.aggregate({
        where: { shopId },
        _sum: { quantity: true },
        _count: true,
      });

      const newTiresValue = await prisma.tire.findMany({
        where: { shopId },
        select: { quantity: true, priceBuy: true, priceSell: true },
      });

      let newTiresBuyValue = 0;
      let newTiresSellValue = 0;
      for (const tire of newTiresValue) {
        newTiresBuyValue += tire.quantity * tire.priceBuy;
        newTiresSellValue += tire.quantity * tire.priceSell;
      }

      // Used tires summary
      const usedTires = await prisma.usedTire.aggregate({
        where: { shopId },
        _sum: { quantity: true },
        _count: true,
      });

      const usedTiresValue = await prisma.usedTire.findMany({
        where: { shopId },
        select: { quantity: true, priceBuy: true, priceSell: true },
      });

      let usedTiresBuyValue = 0;
      let usedTiresSellValue = 0;
      for (const tire of usedTiresValue) {
        usedTiresBuyValue += tire.quantity * tire.priceBuy;
        usedTiresSellValue += tire.quantity * (tire.priceSell || 0);
      }

      return {
        newTires: {
          count: newTires._sum.quantity || 0,
          types: newTires._count,
          buyValue: newTiresBuyValue,
          sellValue: newTiresSellValue,
        },
        usedTires: {
          count: usedTires._sum.quantity || 0,
          types: usedTires._count,
          buyValue: usedTiresBuyValue,
          sellValue: usedTiresSellValue,
        },
        total: {
          count: (newTires._sum.quantity || 0) + (usedTires._sum.quantity || 0),
          buyValue: newTiresBuyValue + usedTiresBuyValue,
          sellValue: newTiresSellValue + usedTiresSellValue,
        },
      };
    } catch (error) {
      logger.error('Error getting warehouse summary:', error);
      throw error;
    }
  }

  async getNewTiresStock(shopId) {
    return prisma.tire.findMany({
      where: { shopId },
      orderBy: [{ brand: 'asc' }, { size: 'asc' }],
    });
  }

  async getUsedTiresStock(shopId) {
    return prisma.usedTire.findMany({
      where: { shopId },
      orderBy: [{ size: 'asc' }, { condition: 'asc' }],
    });
  }

  async getOutOfStock(shopId) {
    const [newTires, usedTires] = await Promise.all([
      prisma.tire.findMany({
        where: { shopId, quantity: 0 },
      }),
      prisma.usedTire.findMany({
        where: { shopId, quantity: 0 },
      }),
    ]);

    return { newTires, usedTires };
  }

  async getLowStock(shopId, threshold = 3) {
    const [newTires, usedTires] = await Promise.all([
      prisma.tire.findMany({
        where: { 
          shopId, 
          quantity: { gt: 0, lte: threshold } 
        },
      }),
      prisma.usedTire.findMany({
        where: { 
          shopId, 
          quantity: { gt: 0, lte: threshold } 
        },
      }),
    ]);

    return { newTires, usedTires };
  }

  async getWarehouseLogs(shopId, options = {}) {
    const { page = 1, limit = 20, logType, itemType, startDate, endDate } = options;
    const skip = (page - 1) * limit;

    const where = {};
    
    if (logType) where.logType = logType;
    if (itemType) where.itemType = itemType;
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [logs, total] = await Promise.all([
      prisma.warehouseLog.findMany({
        where,
        include: {
          tire: true,
          usedTire: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.warehouseLog.count({ where }),
    ]);

    return {
      logs,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
    };
  }
}

module.exports = new WarehouseService();
