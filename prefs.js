/**
 * Per-user preferences, read from the dashboard instead of from here.
 *
 * Language, timezone, brief times and categories used to live only in this
 * bot's SQLite, while the web kept its own copy of the category list. Two
 * stores for one fact is how they end up disagreeing, and they did: one user's
 * web list was five English categories that appeared on none of her tasks.
 * Postgres is the source of truth now.
 *
 * SQLite stays as a **local mirror**, and that is deliberate:
 *
 *   - Every read in melissa.js is synchronous (`db.getUser(chatId)`), including
 *     reads inside cron callbacks. Making them all async to await an HTTP call
 *     would touch every call site for no benefit.
 *   - If the dashboard is down or Vercel is cold, the bot has to keep answering.
 *     A brief that does not go out because a preference lookup failed is a
 *     worse failure than a preference being a few minutes stale.
 *
 * So: writes go to the API first and are mirrored locally; reads come from the
 * mirror; a background pull keeps the mirror fresh. The mirror is never the
 * authority — anything it holds was last confirmed by Postgres.
 */

const db = require('./db');

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

function apiConfig(cfg) {
  const base = (cfg && cfg.task_api_base) || '';
  const secret = (cfg && cfg.task_api_secret) || '';
  return base && secret ? { base, secret } : null;
}

async function callApi(cfg, chatId, method, body) {
  const api = apiConfig(cfg);
  if (!api) throw new Error('task_api_base/task_api_secret not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${api.base}/api/user/preferences`, {
      method,
      headers: {
        'Authorization': `Bearer ${api.secret}`,
        'X-Telegram-Chat-Id': String(chatId),
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** API shape -> the SQLite columns melissa.js already reads. */
function toMirror(prefs) {
  const keywords = prefs.categoryKeywords || {};
  const categories = (prefs.tipoOptions || []).map(name => ({
    name,
    keywords: Array.isArray(keywords[name]) ? keywords[name] : []
  }));
  return {
    language:      prefs.language || 'es',
    timezone:      prefs.timezone || 'America/Los_Angeles',
    brief_morning: prefs.briefMorning === '' ? '' : (prefs.briefMorning || '07:00'),
    brief_evening: prefs.briefEvening === '' ? '' : (prefs.briefEvening || '20:00'),
    categories:    JSON.stringify(categories)
  };
}

/** The reverse, for pushing a locally-made change up. */
function fromMirror(user) {
  let cats = [];
  try { cats = JSON.parse(user.categories || '[]'); } catch { cats = []; }
  const categoryKeywords = {};
  for (const c of cats) {
    if (c && c.name && Array.isArray(c.keywords) && c.keywords.length) categoryKeywords[c.name] = c.keywords;
  }
  const patch = {
    language: user.language === 'en' ? 'en' : 'es',
    timezone: user.timezone || 'America/Los_Angeles',
    briefMorning: user.brief_morning === '' ? '' : (user.brief_morning || '07:00'),
    briefEvening: user.brief_evening === '' ? '' : (user.brief_evening || '20:00')
  };
  if (cats.length) {
    patch.tipoOptions = cats.map(c => c.name).filter(Boolean);
    patch.categoryKeywords = categoryKeywords;
  }
  return patch;
}

/**
 * Reads one user's preferences without touching the mirror.
 *
 * The health check needs to compare the two sides, and a read that silently
 * repairs what it is measuring cannot detect drift.
 */
async function fetchRemote(cfg, chatId) {
  return callApi(cfg, chatId, 'GET');
}

/**
 * Pulls one user's preferences and refreshes the mirror.
 * Returns true when the mirror actually changed, so the caller can decide
 * whether the brief crons need rebuilding.
 */
async function pull(cfg, chatId) {
  const prefs = await fetchRemote(cfg, chatId);
  const next = toMirror(prefs);
  const current = db.getUser(chatId) || {};
  const changed = Object.keys(next).some(k => String(current[k] ?? '') !== String(next[k]));
  if (changed) db.updateUser(chatId, next);
  return changed;
}

/**
 * Writes a change to Postgres, then mirrors it.
 *
 * Order matters: if the API write fails this throws and the mirror keeps the old
 * value, so the two never silently disagree in the direction where the bot
 * believes something Postgres never accepted.
 */
async function push(cfg, chatId, patch) {
  const prefs = await callApi(cfg, chatId, 'POST', patch);
  db.updateUser(chatId, toMirror(prefs));
  return prefs;
}

/** Every locally known user, best-effort. Returns how many mirrors moved. */
async function pullAll(cfg) {
  let changed = 0;
  let failed = 0;
  for (const user of db.listUsers()) {
    try {
      if (await pull(cfg, user.chat_id)) changed++;
    } catch (err) {
      failed++;
      console.log(`[prefs] pull failed for ${user.chat_id}: ${err.message}`);
    }
  }
  if (failed) console.log(`[prefs] ${failed} user(s) could not be refreshed — serving the local mirror`);
  return changed;
}

/**
 * Keeps the mirror fresh in the background.
 *
 * `onChange` fires only when something actually moved, because the only reason
 * to care is rescheduling brief crons — and tearing those down and rebuilding
 * them every fifteen minutes for no reason is how a brief goes missing.
 */
function startBackgroundSync(cfg, onChange) {
  const tick = async () => {
    try {
      if (await pullAll(cfg) > 0 && typeof onChange === 'function') onChange();
    } catch (err) {
      console.log(`[prefs] background sync failed: ${err.message}`);
    }
  };
  const timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { fetchRemote, pull, push, pullAll, startBackgroundSync, toMirror, fromMirror };

/* ─── Deudas ───────────────────────────────────────────────────────────────
   Igual que las preferencias: Postgres es la fuente. A diferencia de ellas NO
   hay espejo local, y es a propósito — las deudas solo se leen cuando alguien
   las pide en una conversación, que ya es un camino asíncrono. Un espejo sin
   lector síncrono es solo otra copia que se puede desincronizar. */

async function debtsApi(cfg, chatId, method, path = '', body) {
  const base = (cfg && cfg.task_api_base) || '';
  const secret = (cfg && cfg.task_api_secret) || '';
  if (!base || !secret) throw new Error('task_api_base/task_api_secret not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/debts${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${secret}`,
        'X-Telegram-Chat-Id': String(chatId),
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { message = JSON.parse(text).error || message; } catch {}
      throw new Error(message);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

const fmtMoney = (amount, currency) =>
  `${Number.isInteger(amount) ? amount : amount.toFixed(2)} ${currency}`;

async function addDebt(cfg, chatId, { name, reason = '', amount, currency = 'USD', direction }) {
  if (!name || amount == null) return 'Falta el nombre o el monto.';
  const { debt } = await debtsApi(cfg, chatId, 'POST', '', {
    name, reason, amount: Number(amount), currency, direction
  });
  const verbo = debt.direction === 'Debo yo' ? 'Le debes' : 'Te debe';
  return `✅ Registrado en Finanzas: ${verbo} ${fmtMoney(debt.amount, debt.currency)} — ${debt.name}` +
         `${debt.reason ? ' (' + debt.reason + ')' : ''}. Estado: ${debt.status}.`;
}

async function listDebts(cfg, chatId, filter = 'pending') {
  const { debts } = await debtsApi(cfg, chatId, 'GET');
  const keep = {
    all:      () => true,
    paid:     d => d.status === 'Pagado',
    pending:  d => d.status !== 'Pagado',
    me_deben: d => d.direction === 'Me deben' && d.status !== 'Pagado',
    debo_yo:  d => d.direction === 'Debo yo'  && d.status !== 'Pagado',
  }[filter] || (d => d.status !== 'Pagado');

  const rows = debts.filter(keep);
  if (rows.length === 0) return `Sin deudas (${filter}).`;
  return `💰 Deudas (${filter}):\n` + rows.map(d =>
    `- ${d.name} — ${fmtMoney(d.amount, d.currency)} — ${d.direction}` +
    `${d.reason ? ' — ' + d.reason : ''} — ${d.status} [#${d.id}]`
  ).join('\n');
}

async function updateDebt(cfg, chatId, id, status) {
  if (!id) return 'Falta el id de la deuda [#].';
  const wantsPaid = String(status || '').toLowerCase().includes('pag');
  try {
    const { debt } = await debtsApi(cfg, chatId, 'PATCH', `/${id}`, {
      status: wantsPaid ? 'Pagado' : 'Por pagar'
    });
    const when = debt.statusChangedAt ? ` (${debt.statusChangedAt.slice(0, 10)})` : '';
    return `✅ Deuda [#${id}] → ${debt.status}${when}.`;
  } catch (err) {
    if (/No existe/i.test(err.message)) return `No se encontró la deuda [#${id}].`;
    throw err;
  }
}

module.exports.addDebt = addDebt;
module.exports.listDebts = listDebts;
module.exports.updateDebt = updateDebt;
