const { prisma } = require('../utils/database');
const logger = require('../utils/logger');
const { getStartOfDay, getEndOfDay, getStartOfMonth, getEndOfMonth } = require('../utils/helpers');

class SalesService {
  async createSale(data) {
    try {
      const sale = await prisma.$transaction(async (tx) => {
        // Create sale record
        const newSale = await tx.sale.create({
          data: {
            itemType: data.itemType,
            tireId: data.tireId,
            usedTireId: data.usedTireId,
            quantity: data.quantity,
            totalPrice: data.totalPrice,
            adminId: data.adminId,
            shopId: data.shopId,
          },
          include: {
            tire: true,
            usedTire: true,
          },
        });

        // Update stock
        if (data.itemType === 'NEW' && data.tireId) {
          await tx.tire.update({
            where: { id: data.tireId },
            data: { quantity: { decrement: data.quantity } },
          });
        } else if (data.itemType === 'USED' && data.usedTireId) {
          await tx.usedTire.update({
            where: { id: data.usedTireId },
            data: { quantity: { decrement: data.quantity } },
          });
        }

        // Log warehouse exit
        await tx.warehouseLog.create({
          data: {
            itemType: data.itemType,
            tireId: data.tireId,
            usedTireId: data.usedTireId,
            logType: 'OUT',
            quantity: data.quantity,
            price: data.totalPrice,
          },
        });

        return newSale;
      });

      return sale;
    } catch (error) {
      logger.error('Error creating sale:', error);
      throw error;
    }
  }

  async getSaleById(id) {
    return prisma.sale.findUnique({
      where: { id },
      include: {
        tire: true,
        usedTire: true,
        admin: true,
      },
    });
  }

  async getSales(shopId, options = {}) {
    const { page = 1, limit = 10, startDate, endDate, itemType } = options;
    const skip = (page - 1) * limit;

    const where = { shopId };

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    if (itemType) {
      where.itemType = itemType;
    }

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        include: {
          tire: true,
          usedTire: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.sale.count({ where }),
    ]);

    return {
      sales,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
    };
  }

  async getDailySales(shopId, date = new Date()) {
    const startOfDay = getStartOfDay(date);
    const endOfDay = getEndOfDay(date);

    const sales = await prisma.sale.findMany({
      where: {
        shopId,
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      include: {
        tire: true,
        usedTire: true,
      },
    });

    const summary = {
      newTires: { count: 0, total: 0 },
      usedTires: { count: 0, total: 0 },
      totalSales: 0,
      totalRevenue: 0,
    };

    for (const sale of sales) {
      if (sale.itemType === 'NEW') {
        summary.newTires.count += sale.quantity;
        summary.newTires.total += sale.totalPrice;
      } else {
        summary.usedTires.count += sale.quantity;
        summary.usedTires.total += sale.totalPrice;
      }
      summary.totalSales += sale.quantity;
      summary.totalRevenue += sale.totalPrice;
    }

    return { sales, summary };
  }

  async getMonthlySales(shopId, date = new Date()) {
    const startOfMonth = getStartOfMonth(date);
    const endOfMonth = getEndOfMonth(date);

    const sales = await prisma.sale.groupBy({
      by: ['itemType'],
      where: {
        shopId,
        createdAt: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
      },
      _sum: {
        quantity: true,
        totalPrice: true,
      },
      _count: true,
    });

    const dailySales = await prisma.$queryRaw`
      SELECT 
        DATE(created_at) as date,
        item_type,
        SUM(quantity) as quantity,
        SUM(total_price) as total
      FROM sales
      WHERE shop_id = ${shopId}
        AND created_at >= ${startOfMonth}
        AND created_at <= ${endOfMonth}
      GROUP BY DATE(created_at), item_type
      ORDER BY date DESC
    `;

    return { sales, dailySales };
  }

  async getIncomeExpense(shopId, startDate, endDate) {
    const where = {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    };

    // Income from sales
    const salesIncome = await prisma.sale.aggregate({
      where: { ...where, shopId },
      _sum: { totalPrice: true },
    });

    // Expenses (purchases/incoming stock)
    const tireWhere = { ...where, logType: 'IN' };
    
    const newTireExpenses = await prisma.warehouseLog.aggregate({
      where: { ...tireWhere, itemType: 'NEW' },
      _sum: { price: true },
    });

    const usedTireExpenses = await prisma.warehouseLog.aggregate({
      where: { ...tireWhere, itemType: 'USED' },
      _sum: { price: true },
    });

    return {
      income: salesIncome._sum.totalPrice || 0,
      expenses: {
        newTires: newTireExpenses._sum.price || 0,
        usedTires: usedTireExpenses._sum.price || 0,
        total: (newTireExpenses._sum.price || 0) + (usedTireExpenses._sum.price || 0),
      },
      profit: (salesIncome._sum.totalPrice || 0) - 
              ((newTireExpenses._sum.price || 0) + (usedTireExpenses._sum.price || 0)),
    };
  }
}

module.exports = new SalesService();
