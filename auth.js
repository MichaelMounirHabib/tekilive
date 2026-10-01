/**
 * Stateless auth: one admin account defined by env (ADMIN_EMAIL /
 * ADMIN_PASSWORD), and a JWT signed with SESSION_SECRET carried in an
 * httpOnly cookie. No database and no server-side session store.
 *
 * All three must be set for accounts to switch on. Without them (local dev)
 * the presenter console and branding stay open, as before. In production
 * server.js refuses to start without them (see configProblems).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

const COOKIE_NAME = 'tekilive_session';
const TOKEN_TTL = '12h'; // long enough to cover a full event day
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function isEnabled() {
  return !!(SESSION_SECRET && ADMIN_EMAIL && ADMIN_PASSWORD);
}

// What stops this deployment from being safe to run in production.
function configProblems() {
  const problems = [];
  if (SESSION_SECRET.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
  if (!ADMIN_EMAIL) problems.push('ADMIN_EMAIL is required');
  if (ADMIN_PASSWORD.length < 12) problems.push('ADMIN_PASSWORD must be at least 12 characters');
  return problems;
}

// Hashing both sides first gives timingSafeEqual equal-length inputs, so the
// comparison time says nothing about the length or content of either value.
function sameSecret(a, b) {
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function checkAdminCredentials(email, password) {
  if (!isEnabled()) return false;
  const emailOk = sameSecret(String(email || '').trim().toLowerCase(), ADMIN_EMAIL);
  const passwordOk = sameSecret(password || '', ADMIN_PASSWORD);
  return emailOk && passwordOk;
}

function signToken() {
  return jwt.sign({ email: ADMIN_EMAIL, role: 'admin' }, SESSION_SECRET, { expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, SESSION_SECRET, { algorithms: ['HS256'] });
    return payload.role === 'admin' ? payload : null;
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
function requireAdmin(req, res, next) {
  const user = readUserFromRequest(req);
  if (!user) return res.status(403).json({ error: 'Admin access required' });
  req.authUser = user;
  next();
}

module.exports = {
  isEnabled,
  configProblems,
  checkAdminCredentials,
  signToken,
  cookieHeader,
  clearCookieHeader,
  readUserFromRequest,
  requireAdmin,
};
