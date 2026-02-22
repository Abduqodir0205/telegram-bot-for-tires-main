/**
 * API Layer: Mobil ilova uchun Express routerlari.
 * /api/auth ochiq; qolganlari JWT. Inventory va reports faqat ADMIN/BOSS.
 */
const express = require('express');
const { jwtAuth } = require('./middleware/jwtAuth');
const { roleCheck } = require('./middleware/roleCheck');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const shopRoutes = require('./routes/shops');
const inventoryRoutes = require('./routes/inventory');
const reportsRoutes = require('./routes/reports');

const router = express.Router();

router.use(express.json());

// Auth: login/register ochiq
router.use('/auth', authRoutes);

// Himoyalangan route'lar (JWT talab qilinadi)
const protected = express.Router();
protected.use(jwtAuth);
protected.use('/users', userRoutes);
protected.use('/shops', shopRoutes);
// Inventory va reports: faqat ADMIN yoki BOSS
protected.use('/inventory', roleCheck(['ADMIN']), inventoryRoutes);
protected.use('/reports', roleCheck(['ADMIN']), reportsRoutes);
router.use(protected);

// 404 API
router.use((req, res) => {
  res.status(404).json({ error: 'Endpoint topilmadi', path: req.path });
});

// Xato ishlovchi
router.use((err, req, res, next) => {
  console.error('API Error:', err);
  res.status(500).json({ error: 'Server xatosi', code: 'INTERNAL_ERROR' });
});

module.exports = router;
