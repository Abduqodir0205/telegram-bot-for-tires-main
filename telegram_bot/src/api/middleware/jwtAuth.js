/**
 * JWT middleware: Authorization: Bearer <token> tekshiradi, req.user va req.authPayload ni to'ldiradi.
 */
const authService = require('../../services/authService');

function jwtAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token talab qilinadi', code: 'UNAUTHORIZED' });
  }
  const token = authHeader.slice(7);
  authService.getUserByToken(token)
    .then((result) => {
      if (!result) {
        return res.status(401).json({ error: 'Token yaroqsiz yoki muddati tugagan', code: 'INVALID_TOKEN' });
      }
      req.user = result.user;
      req.authPayload = result.payload;
      next();
    })
    .catch((err) => {
      next(err);
    });
}

module.exports = { jwtAuth };
