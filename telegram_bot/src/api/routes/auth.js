const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');

function toSafeUser(user) {
  if (!user) return user;
  const u = { ...user, passwordHash: undefined };
  if (typeof u.telegramId === 'bigint') u.telegramId = u.telegramId.toString();
  return u;
}

/**
 * POST /api/auth/login
 * Body: { phone, password }
 * Response: { user, token } (user dan passwordHash tashlab yuboriladi)
 */
router.post('/login', async (req, res, next) => {
  try {
    const { phone, password } = req.body || {};
    const result = await authService.loginByPhone(phone, password);
    if (!result) {
      return res.status(401).json({ error: 'Telefon yoki parol noto\'g\'ri', code: 'INVALID_CREDENTIALS' });
    }
    const { user, token } = result;
    res.json({ user: toSafeUser(user), token });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/register
 * Body: { phone, password, firstName?, lastName? }
 */
router.post('/register', async (req, res, next) => {
  try {
    const { phone, password, firstName, lastName } = req.body || {};
    const result = await authService.registerByPhone(phone, password, { firstName, lastName });
    if (!result) {
      return res.status(409).json({ error: 'Bu telefon allaqachon ro\'yxatdan o\'tgan', code: 'PHONE_EXISTS' });
    }
    const { user, token } = result;
    res.status(201).json({ user: toSafeUser(user), token });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
