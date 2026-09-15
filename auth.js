/**
 * Stateless auth: a JWT signed with SESSION_SECRET, carried in an
 * httpOnly cookie. No server-side session store needed.
 */

const jwt = require('jsonwebtoken');
const cookie = require('cookie');

const COOKIE_NAME = 'tekilive_session';
const TOKEN_TTL = '12h'; // long enough to cover a full event day
const SESSION_SECRET = process.env.SESSION_SECRET || '';

function isEnabled() {
  return !!SESSION_SECRET;
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, sessionCode: user.session_code, stageName: user.stage_name },
    SESSION_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch {
    return null;
  }
}

function cookieHeader(token) {
  return cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
}

function clearCookieHeader() {
  return cookie.serialize(COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

// Reads the auth cookie from any raw Node request (works for both normal
// Express requests and the raw upgrade request during a WebSocket handshake).
function readUserFromRequest(req) {
  if (!isEnabled()) return null;
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parse(header);
  const token = parsed[COOKIE_NAME];
  if (!token) return null;
  return verifyToken(token);
}

// Express middleware
function requireAuth(req, res, next) {
  const user = readUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.authUser = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = readUserFromRequest(req);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.authUser = user;
  next();
}

module.exports = {
  isEnabled,
  signToken,
  verifyToken,
  cookieHeader,
  clearCookieHeader,
  readUserFromRequest,
  requireAuth,
  requireAdmin,
};
