/**
 * Account storage. Everything else in this app is deliberately in-memory
 * and wiped on restart (see server.js), but accounts need to survive a
 * redeploy or crash mid-event, so this is the one piece backed by a real
 * database (Postgres).
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL || '';

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

async function init() {
  if (!pool) {
    console.warn('[db] DATABASE_URL not set — account login/admin features are disabled.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'stage_manager')),
      session_code TEXT,
      stage_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminEmail && adminPassword) {
    const existing = await findUserByEmail(adminEmail);
    if (!existing) {
      await createUser({ email: adminEmail, password: adminPassword, role: 'admin' });
      console.log(`[db] Bootstrapped initial admin account: ${adminEmail}`);
    }
  }
}

function isEnabled() {
  return !!pool;
}

async function findUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createUser({ email, password, role, sessionCode = null, stageName = null }) {
  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, session_code, stage_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [email.trim().toLowerCase(), passwordHash, role, sessionCode ? sessionCode.trim().toUpperCase() : null, stageName]
  );
  return rows[0];
}

async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password_hash);
}

async function listStageManagers() {
  const { rows } = await pool.query(
    `SELECT id, email, role, session_code, stage_name, created_at FROM users
     WHERE role = 'stage_manager' ORDER BY created_at DESC`
  );
  return rows;
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    sessionCode: user.session_code,
    stageName: user.stage_name,
  };
}

module.exports = {
  init,
  isEnabled,
  findUserByEmail,
  findUserById,
  createUser,
  verifyPassword,
  listStageManagers,
  deleteUser,
  toPublicUser,
};
