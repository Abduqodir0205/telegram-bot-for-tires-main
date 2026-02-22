/**
 * Role tekshiruv: faqat berilgan rollar (ADMIN / BOSS) endpoint ga kirishi mumkin.
 * Inventory/summary va hisobotlar faqat ADMIN (yoki kelajakda BOSS) uchun.
 */
const BOSS_ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_IDS?.split(',')[0]) || 222592599;

/**
 * @param {string[]} allowedRoles - masalan ['ADMIN'] yoki ['ADMIN', 'BOSS']
 */
function roleCheck(allowedRoles = ['ADMIN']) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Avtorizatsiya talab qilinadi', code: 'UNAUTHORIZED' });
    }
    const role = (user.role || 'USER').toUpperCase();
    const isBoss = user.telegramId && Number(user.telegramId) === BOSS_ADMIN_TELEGRAM_ID;
    const allowed = allowedRoles.includes(role) || (allowedRoles.includes('BOSS') && isBoss);
    if (!allowed) {
      return res.status(403).json({ error: 'Bu bo\'limga kirish huquqingiz yo\'q', code: 'FORBIDDEN' });
    }
    next();
  };
}

module.exports = { roleCheck };
