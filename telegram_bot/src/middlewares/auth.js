const { prisma } = require('../utils/database');
const logger = require('../utils/logger');

async function authMiddleware(ctx, next) {
  try {
    const telegramId = ctx.from?.id;
    
    if (!telegramId) {
      logger.warn('No Telegram ID found in context');
      return next();
    }

    const shopId = parseInt(process.env.DEFAULT_SHOP_ID) || 1;

    // Check if user is admin
    const admin = await prisma.admin.findUnique({
      where: { telegramId: BigInt(telegramId) },
      include: { shop: true },
    });

    if (admin) {
      ctx.isAdmin = true;
      ctx.admin = admin;
      ctx.shop = admin.shop;
      ctx.shopId = admin.shopId;
    } else {
      ctx.isAdmin = false;
      ctx.shopId = shopId;
      
      // Get shop info for regular users
      ctx.shop = await prisma.shop.findUnique({
        where: { id: shopId },
      });
    }

    // Get or create user record
    let user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          telegramId: BigInt(telegramId),
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
          username: ctx.from.username,
          role: ctx.isAdmin ? 'ADMIN' : 'USER',
          shopId: ctx.shopId,
        },
      });
      logger.info(`New user created: ${user.firstName} (${telegramId})`);
    }

    ctx.user = user;

    return next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    return next();
  }
}

// Middleware to check admin access
function requireAdmin(ctx, next) {
  if (!ctx.isAdmin) {
    return ctx.reply('⛔ Bu bo\'limga faqat adminlar kirishi mumkin.');
  }
  return next();
}

module.exports = {
  authMiddleware,
  requireAdmin,
};
