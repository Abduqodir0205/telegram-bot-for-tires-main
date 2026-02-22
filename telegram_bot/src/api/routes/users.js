const express = require('express');
const router = express.Router();

/**
 * GET /api/users/me
 * JWT talab qilinadi. Joriy foydalanuvchi ma'lumotlari (passwordHash siz).
 */
function toSafeUser(user) {
  if (!user) return user;
  const u = { ...user, passwordHash: undefined };
  if (typeof u.telegramId === 'bigint') u.telegramId = u.telegramId.toString();
  return u;
}

router.get('/me', (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: 'Foydalanuvchi topilmadi', code: 'UNAUTHORIZED' });
  }
  res.json(toSafeUser(user));
});

module.exports = router;
