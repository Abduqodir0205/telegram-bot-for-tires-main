const express = require('express');
const router = express.Router();
const inventoryService = require('../../services/inventoryService');

function parseShopId(req) {
  const raw = req.query.shopId ?? req.user?.shopId ?? process.env.DEFAULT_SHOP_ID;
  const id = parseInt(raw, 10);
  return isNaN(id) ? 1 : id;
}

/**
 * GET /api/inventory/summary?shopId=1
 * To'liq sklad qoldig'i: yangi shina, ishchi shina, rabochiy balon (JWT himoyalangan).
 */
router.get('/summary', async (req, res, next) => {
  try {
    const shopId = parseShopId(req);
    const summary = await inventoryService.getFullInventorySummary(shopId);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/inventory/new?shopId=1
 * Yangi shinalar qoldig'i (Prisma Tire).
 */
router.get('/new', async (req, res, next) => {
  try {
    const shopId = parseShopId(req);
    const data = await inventoryService.getNewTireBalance(shopId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/inventory/used?shopId=1
 * Ishchi shinalar qoldig'i (Prisma UsedTire).
 */
router.get('/used', async (req, res, next) => {
  try {
    const shopId = parseShopId(req);
    const data = await inventoryService.getUsedTireBalance(shopId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/inventory/rabochiy?shopId=1
 * Rabochiy balonlar qoldig'i (legacy rabochiy_balon).
 */
router.get('/rabochiy', async (req, res, next) => {
  try {
    const shopId = parseShopId(req);
    const data = await inventoryService.getRabochiyBalonBalance(shopId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
