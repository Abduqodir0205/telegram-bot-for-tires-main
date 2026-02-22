/**
 * Hisobotlar va Excel uchun ma'lumot yig'uvchi endpointlar (JWT + ADMIN/BOSS).
 */
const express = require('express');
const router = express.Router();
const inventoryService = require('../../services/inventoryService');
const saleService = require('../../services/saleService');
const shopService = require('../../services/shopService');

function parseShopId(req) {
  const raw = req.query.shopId ?? req.user?.shopId ?? process.env.DEFAULT_SHOP_ID;
  const id = parseInt(raw, 10);
  return isNaN(id) ? 1 : id;
}

/**
 * GET /api/reports/inventory?shopId=1
 * Sklad qoldiqlari (legacy kirim/chiqim) + yangi/ishchi/rabochiy — Excel va bot hisobotlari uchun.
 */
router.get('/inventory', async (req, res, next) => {
  try {
    const shopId = parseShopId(req);
    const [skladRows, fullSummary, rabOmbor] = await Promise.all([
      inventoryService.getSkladRowsWithValuation(shopId),
      inventoryService.getFullInventorySummary(shopId),
      inventoryService.getRabochiyOmborValue(shopId),
    ]);
    res.json({
      shopId,
      skladRows,
      fullSummary,
      rabOmbor,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/reports/sales?shopId=1&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Chiqim va rabochiy sotuv ro'yxati + jami (hisobot davri uchun).
 */
router.get('/sales', async (req, res, next) => {
  try {
    const shopId = parseShopId(req);
    const startDate = req.query.startDate || new Date().toISOString().slice(0, 10);
    const endDate = req.query.endDate || new Date().toISOString().slice(0, 10);
    const [chiqimRows, rabSotuvRows, chiqimTotals] = await Promise.all([
      saleService.getChiqimByDateRange(startDate, endDate, shopId),
      saleService.getRabochiySotuvByDateRange(startDate, endDate, shopId),
      saleService.getChiqimTotals(shopId, startDate, endDate),
    ]);
    res.json({
      shopId,
      startDate,
      endDate,
      chiqimRows,
      rabSotuvRows,
      chiqimTotals,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/reports/dashboard?shopId=1
 * Boshqaruv paneli uchun qisqa ko'rsatkichlar (chiqim jami, kirim jami, rabochiy balon soni va h.k.).
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const shopId = parseShopId(req);
    const skladRows = await inventoryService.getSkladRowsWithValuation(shopId);
    const rabOmbor = await inventoryService.getRabochiyOmborValue(shopId);
    const chiqimTotals = await saleService.getChiqimTotals(shopId); // all time if no dates
    const investitsiya = skladRows.reduce((s, r) => s + Number(r.qoldiq || 0) * Number(r.tan_narx || 0), 0);
    const kutilayotganFoyda = skladRows.reduce(
      (s, r) => s + Number(r.qoldiq || 0) * (Number(r.sotish_narx || 0) - Number(r.tan_narx || 0)),
      0
    );
    res.json({
      shopId,
      chiqimTotals,
      rabOmbor,
      skladInvestitsiya: investitsiya,
      kutilayotganFoyda,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
