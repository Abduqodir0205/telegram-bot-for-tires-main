const { prisma } = require('../utils/database');
const logger = require('../utils/logger');

class TireService {
  // New Tires
  async createTire(data) {
    try {
      const tire = await prisma.tire.create({
        data: {
          shopId: data.shopId,
          brand: data.brand,
          size: data.size,
          priceBuy: data.priceBuy,
          priceSell: data.priceSell,
          quantity: data.quantity || 0,
        },
      });

      // Log warehouse entry
      if (data.quantity > 0) {
        await prisma.warehouseLog.create({
          data: {
            itemType: 'NEW',
            tireId: tire.id,
            logType: 'IN',
            quantity: data.quantity,
            price: data.priceBuy * data.quantity,
          },
        });
      }

      return tire;
    } catch (error) {
      logger.error('Error creating tire:', error);
      throw error;
    }
  }

  async getTireById(id) {
    return prisma.tire.findUnique({
      where: { id },
    });
  }

  async getAllTires(shopId, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    
    const [tires, total] = await Promise.all([
      prisma.tire.findMany({
        where: { shopId },
        orderBy: [{ brand: 'asc' }, { size: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.tire.count({ where: { shopId } }),
    ]);

    return {
      tires,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
    };
  }

  async getAvailableTires(shopId) {
    return prisma.tire.findMany({
      where: {
        shopId,
        quantity: { gt: 0 },
      },
      orderBy: [{ brand: 'asc' }, { size: 'asc' }],
    });
  }

  async updateTire(id, data) {
    const oldTire = await this.getTireById(id);
    
    const tire = await prisma.tire.update({
      where: { id },
      data,
    });

    // Log quantity change if applicable
    if (data.quantity !== undefined && oldTire) {
      const diff = data.quantity - oldTire.quantity;
      if (diff !== 0) {
        await prisma.warehouseLog.create({
          data: {
            itemType: 'NEW',
            tireId: id,
            logType: diff > 0 ? 'IN' : 'OUT',
            quantity: Math.abs(diff),
            price: Math.abs(diff) * (diff > 0 ? tire.priceBuy : tire.priceSell),
          },
        });
      }
    }

    return tire;
  }

  async addStock(id, quantity, price) {
    const tire = await prisma.tire.update({
      where: { id },
      data: {
        quantity: { increment: quantity },
        priceBuy: price || undefined,
      },
    });

    await prisma.warehouseLog.create({
      data: {
        itemType: 'NEW',
        tireId: id,
        logType: 'IN',
        quantity,
        price: price * quantity,
      },
    });

    return tire;
  }

  async deleteTire(id) {
    return prisma.tire.delete({
      where: { id },
    });
  }

  async searchTires(shopId, query) {
    return prisma.tire.findMany({
      where: {
        shopId,
        OR: [
          { brand: { contains: query, mode: 'insensitive' } },
          { size: { contains: query, mode: 'insensitive' } },
        ],
      },
    });
  }

  async getOutOfStockTires(shopId) {
    return prisma.tire.findMany({
      where: {
        shopId,
        quantity: 0,
      },
    });
  }

  async getLowStockTires(shopId, threshold = 3) {
    return prisma.tire.findMany({
      where: {
        shopId,
        quantity: { lte: threshold, gt: 0 },
      },
    });
  }

  // Used Tires
  async createUsedTire(data) {
    try {
      const usedTire = await prisma.usedTire.create({
        data: {
          shopId: data.shopId,
          size: data.size,
          condition: data.condition,
          priceBuy: data.priceBuy,
          priceSell: data.priceSell,
          quantity: data.quantity || 0,
        },
      });

      if (data.quantity > 0) {
        await prisma.warehouseLog.create({
          data: {
            itemType: 'USED',
            usedTireId: usedTire.id,
            logType: 'IN',
            quantity: data.quantity,
            price: data.priceBuy * data.quantity,
          },
        });
      }

      return usedTire;
    } catch (error) {
      logger.error('Error creating used tire:', error);
      throw error;
    }
  }

  async getUsedTireById(id) {
    return prisma.usedTire.findUnique({
      where: { id },
    });
  }

  async getAllUsedTires(shopId, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    
    const [tires, total] = await Promise.all([
      prisma.usedTire.findMany({
        where: { shopId },
        orderBy: [{ size: 'asc' }, { condition: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.usedTire.count({ where: { shopId } }),
    ]);

    return {
      tires,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
    };
  }

  async getAvailableUsedTires(shopId) {
    return prisma.usedTire.findMany({
      where: {
        shopId,
        quantity: { gt: 0 },
        priceSell: { not: null },
      },
      orderBy: [{ size: 'asc' }, { condition: 'asc' }],
    });
  }

  async updateUsedTire(id, data) {
    return prisma.usedTire.update({
      where: { id },
      data,
    });
  }

  async addUsedStock(id, quantity, priceBuy) {
    const usedTire = await prisma.usedTire.update({
      where: { id },
      data: {
        quantity: { increment: quantity },
      },
    });

    await prisma.warehouseLog.create({
      data: {
        itemType: 'USED',
        usedTireId: id,
        logType: 'IN',
        quantity,
        price: priceBuy * quantity,
      },
    });

    return usedTire;
  }

  async deleteUsedTire(id) {
    return prisma.usedTire.delete({
      where: { id },
    });
  }
}

module.exports = new TireService();
