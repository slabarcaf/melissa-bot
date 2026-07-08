const { DatabaseSync } = require('node:sqlite'); // built into Node >= 22.13 — no native compilation
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || '/root/whatsapp-bot/melissa.db';

let _db;
function getDb() {
  if (!_db) _db = new DatabaseSync(DB_PATH);
  return _db;
}

function migrate() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id        INTEGER PRIMARY KEY,
      name           TEXT,
      preferred_name TEXT,
      onboarding     TEXT DEFAULT 'new',
      timezone       TEXT DEFAULT 'America/Los_Angeles',
      features       TEXT DEFAULT '{}',
      task_user_tag  TEXT,
      categories     TEXT DEFAULT '[]',
      created_at     TEXT DEFAULT (date('now'))
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code        TEXT PRIMARY KEY,
      created_by  INTEGER,
      used_by     INTEGER,
      label       TEXT,
      email       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      expires_at  TEXT DEFAULT (datetime('now', '+30 days'))
    );

    CREATE TABLE IF NOT EXISTS debts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL REFERENCES users(chat_id),
      name              TEXT NOT NULL,
      amount            REAL NOT NULL,
      currency          TEXT DEFAULT 'USD',
      direction         TEXT NOT NULL,
      reason            TEXT,
      status            TEXT DEFAULT 'Por pagar',
      created_at        TEXT DEFAULT (date('now')),
      status_changed_at TEXT
    );
  `);
}

function getUser(chatId) {
  return getDb().prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId) || null;
}

function createUser(chatId, data = {}) {
  getDb().prepare(`
    INSERT OR IGNORE INTO users
      (chat_id, name, preferred_name, onboarding, timezone, features, task_user_tag, categories)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chatId,
    data.name           || null,
    data.preferred_name || null,
    data.onboarding     || 'new',
    data.timezone       || 'America/Los_Angeles',
    JSON.stringify(data.features    || {}),
    String(chatId),
    JSON.stringify(data.categories  || [])
  );
}

function updateUser(chatId, updates) {
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates).map(v =>
    (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
  );
  getDb().prepare(`UPDATE users SET ${fields} WHERE chat_id = ?`).run(...values, chatId);
}

function getDoneUsers() {
  return getDb().prepare("SELECT * FROM users WHERE onboarding = 'done'").all();
}

// ── Invite codes ──────────────────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MELI-';
  // 8 chars over a 32-symbol alphabet ≈ 1.1e12 combinations (brute-force-proof).
  for (let i = 0; i < 8; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

function createInviteCode(label, createdBy, email = null) {
  const db = getDb();
  let code;
  do { code = generateCode(); }
  while (db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code));
  db.prepare('INSERT INTO invite_codes (code, created_by, label, email) VALUES (?, ?, ?, ?)')
    .run(code, createdBy, label, email);
  return code;
}

function claimInviteCode(code, chatId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
  if (!row)                                    return null; // not found
  if (row.used_by)                             return null; // already used
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null; // expired
  db.prepare('UPDATE invite_codes SET used_by = ? WHERE code = ?').run(chatId, code);
  return row.label || null;
}

// ── Debt operations ───────────────────────────────────────────────────────────

function normDirection(direction) {
  const d = (direction || '').toLowerCase();
  if (/(debo|i owe|yo (le )?debo|pagar yo|owe)/.test(d) && !/me deb/.test(d)) return 'Debo yo';
  if (/(me deben|they owe|owes me|me debe)/.test(d)) return 'Me deben';
  if (d.includes('debo')) return 'Debo yo';
  return 'Me deben';
}

function addDebt(userId, { name, reason = '', amount, currency = 'USD', direction }) {
  if (!name || amount == null) return 'Falta el nombre o el monto.';
  const dir = normDirection(direction);
  const cur = (currency || 'USD').toUpperCase();
  getDb().prepare(
    'INSERT INTO debts (user_id, name, amount, currency, direction, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, name, amount, cur, dir, reason || '', 'Por pagar');
  const verbo = dir === 'Debo yo' ? 'Le debes' : 'Te debe';
  return `✅ Registrado en Finanzas: ${verbo} ${amount} ${cur} — ${name}${reason ? ' (' + reason + ')' : ''}. Estado: Por pagar.`;
}

function listDebts(userId, filter = 'pending') {
  const db = getDb();
  const base = 'SELECT * FROM debts WHERE user_id = ?';
  const queries = {
    all:      base + ' ORDER BY id',
    paid:     base + " AND status = 'Pagado' ORDER BY id",
    pending:  base + " AND status != 'Pagado' ORDER BY id",
    me_deben: base + " AND direction = 'Me deben' AND status != 'Pagado' ORDER BY id",
    debo_yo:  base + " AND direction = 'Debo yo' AND status != 'Pagado' ORDER BY id",
  };
  const rows = db.prepare(queries[filter] || queries.pending).all(userId);
  if (rows.length === 0) return `Sin deudas (${filter}).`;
  const lines = rows.map(r =>
    `- ${r.name} — ${r.amount} ${r.currency} — ${r.direction}${r.reason ? ' — ' + r.reason : ''} — ${r.status} [#${r.id}]`
  );
  return `💰 Deudas (${filter}):\n` + lines.join('\n');
}

function updateDebt(userId, id, status) {
  if (!id) return 'Falta el id de la deuda [#].';
  const debt = getDb().prepare('SELECT id FROM debts WHERE id = ? AND user_id = ?').get(id, userId);
  if (!debt) return `No se encontró la deuda [#${id}].`;
  const newStatus = (status || '').toLowerCase().includes('pag') ? 'Pagado' : 'Por pagar';
  const today = new Date().toISOString().slice(0, 10);
  getDb().prepare('UPDATE debts SET status = ?, status_changed_at = ? WHERE id = ? AND user_id = ?')
    .run(newStatus, today, id, userId);
  return `✅ Deuda [#${id}] → ${newStatus} (${today}).`;
}

module.exports = {
  migrate, getUser, createUser, updateUser, getDoneUsers,
  createInviteCode, claimInviteCode,
  addDebt, listDebts, updateDebt,
};
