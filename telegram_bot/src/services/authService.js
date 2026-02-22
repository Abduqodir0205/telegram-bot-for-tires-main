/**
 * Auth Service: Bot (telegram_id) va Mobil ilova (phone/password) uchun yagona kirish.
 * Barcha DB murojaatlari Prisma orqali.
 */
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { prisma } = require('../utils/database');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || process.env.TELEGRAM_BOT_TOKEN || 'fallback-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const BCRYPT_ROUNDS = 10;

/**
 * Bot: telegram_id orqali foydalanuvchi topish yoki yaratish, JWT berish (ixtiyoriy).
 * @param {number|string} telegramId
 * @param {{ firstName?, lastName?, username? }} telegramUser - Bot kontekstidan
 * @returns {{ user, token? }}
 */
async function loginByTelegram(telegramId, telegramUser = {}) {
  const id = BigInt(telegramId);
  let user = await prisma.user.findUnique({
    where: { telegramId: id },
    include: { shop: true },
  });
  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId: id,
        firstName: telegramUser.firstName ?? null,
        lastName: telegramUser.lastName ?? null,
        username: telegramUser.username ?? null,
        role: 'USER',
      },
      include: { shop: true },
    });
    logger.info(`Auth: yangi bot user yaratildi telegram_id=${telegramId}`);
  }
  const token = jwt.sign(
    { userId: user.id, telegramId: String(telegramId), type: 'telegram' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  return { user, token };
}

/**
 * Mobil: phone va password orqali login (bcrypt + JWT).
 * @param {string} phone
 * @param {string} password
 * @returns {{ user, token }} yoki null (xato parol/telefon)
 */
async function loginByPhone(phone, password) {
  if (!phone || !password) return null;
  const normalizedPhone = String(phone).trim();
  const user = await prisma.user.findUnique({
    where: { phone: normalizedPhone },
    include: { shop: true },
  });
  if (!user || !user.passwordHash) return null;
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;
  const token = jwt.sign(
    { userId: user.id, phone: user.phone, type: 'mobile' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  return { user, token };
}

/**
 * Mobil: yangi foydalanuvchi ro'yxatdan o'tkazish (phone + parol).
 * @param {string} phone
 * @param {string} password - ochiq parol (bcrypt bilan hash qilinadi)
 * @param {{ firstName?, lastName? }} profile
 * @returns {{ user, token }} yoki null (telefon band bo'lsa)
 */
async function registerByPhone(phone, password, profile = {}) {
  const normalizedPhone = String(phone).trim();
  const existing = await prisma.user.findUnique({
    where: { phone: normalizedPhone },
  });
  if (existing) return null;
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      phone: normalizedPhone,
      passwordHash,
      firstName: profile.firstName ?? null,
      lastName: profile.lastName ?? null,
      role: 'USER',
    },
    include: { shop: true },
  });
  const token = jwt.sign(
    { userId: user.id, phone: user.phone, type: 'mobile' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  return { user, token };
}

/**
 * JWT token tekshirish, payload qaytarish.
 * @param {string} token
 * @returns {{ userId, telegramId?, phone?, type } | null}
 */
function validateToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload;
  } catch (err) {
    logger.debug('JWT validate error:', err.message);
    return null;
  }
}

/**
 * Token orqali foydalanuvchi olib kelish (API uchun).
 * @param {string} token
 * @returns {Promise<{ user, payload } | null>}
 */
async function getUserByToken(token) {
  const payload = validateToken(token);
  if (!payload?.userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: { shop: true },
  });
  if (!user) return null;
  return { user, payload };
}

module.exports = {
  loginByTelegram,
  loginByPhone,
  registerByPhone,
  validateToken,
  getUserByToken,
  JWT_SECRET,
};
