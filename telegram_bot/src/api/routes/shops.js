const express = require('express');
const router = express.Router();
const shopService = require('../../services/shopService');

/**
 * GET /api/shops
 * Barcha do'konlar ro'yxati (JWT himoyalangan).
 */
router.get('/', async (req, res, next) => {
  try {
    const shops = await shopService.getShops();
    res.json(shops);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/shops/:id
 * Bitta do'kon ma'lumotlari.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const shopId = parseInt(req.params.id, 10);
    if (isNaN(shopId)) {
      return res.status(400).json({ error: 'Noto\'g\'ri do\'kon ID', code: 'INVALID_ID' });
    }
    const shop = await shopService.getShopById(shopId);
    if (!shop) {
      return res.status(404).json({ error: 'Do\'kon topilmadi', code: 'NOT_FOUND' });
    }
    res.json(shop);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
