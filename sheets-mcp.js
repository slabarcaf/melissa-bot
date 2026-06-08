#!/usr/bin/env node
/**
 * MCP server for Google Sheets-backed workflows (Finanzas + Networking).
 * Reuses the OAuth + JSON-RPC-over-stdio pattern from calendar-mcp.js.
 * Always uses the "berkeley" account (owner of both spreadsheets).
 *
 * Spreadsheets:
 *   FINANCE_SHEET_ID — "Finance Ledger"  cols A..H:
 *       A Name | B Reason | C Created | D Amount | E Currency | F Direction | G Status | H Status Changed
 *       Direction: "Me deben" | "Debo yo"      Status: "Por pagar" | "Pagado"
 *   NETWORK_SHEET_ID — "Network Tracker"  cols A..J (existing):
 *       A Name | B Company | C Email | D Location | E Last Contact | F How | G Next Step |
 *       H Communication(status) | I Next step deadline | J Action ?
 */

const https = require("https");

const CLIENT_ID              = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET          = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN_BERKELEY = process.env.GOOGLE_REFRESH_TOKEN_BERKELEY;
const TIMEZONE               = process.env.TIMEZONE || "America/Los_Angeles";

const FINANCE_SHEET_ID = process.env.FINANCE_SHEET_ID;
const NETWORK_SHEET_ID = process.env.NETWORK_SHEET_ID;
// Optional explicit tab names; default = first sheet (no prefix in the range).
const FINANCE_TAB = process.env.FINANCE_TAB || "";
const NETWORK_TAB = process.env.NETWORK_TAB || "";

const ACCOUNT = "berkeley";

// ── OAuth token cache ─────────────────────────────────────────────────────────

const tokenCache = { token: null, expiry: 0 };

async function getAccessToken() {
  if (!REFRESH_TOKEN_BERKELEY) throw new Error("No Berkeley refresh token configured");
  if (tokenCache.token && Date.now() < tokenCache.expiry - 60000) return tokenCache.token;

  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN_BERKELEY,
    grant_type:    "refresh_token",
  }).toString();

  const data = await httpsReq("POST", "oauth2.googleapis.com", "/token", {
    "Content-Type":   "application/x-www-form-urlencoded",
    "Content-Length": Buffer.byteLength(body),
  }, body);

  if (data.error) throw new Error("OAuth error: " + (data.error_description || data.error));
  tokenCache.token  = data.access_token;
  tokenCache.expiry = Date.now() + data.expires_in * 1000;
  return tokenCache.token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsReq(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method, hostname, path, headers }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ error: raw }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function gFetch(method, hostname, path, body = null) {
  const token   = await getAccessToken();
  const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
  const bodyStr = body ? JSON.stringify(body) : null;
  if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
  return httpsReq(method, hostname, path, headers, bodyStr);
}

// ── Sheets API wrappers ───────────────────────────────────────────────────────

const SHEETS_HOST = "sheets.googleapis.com";

function rangeWithTab(tab, a1) {
  return tab ? `${encodeURIComponent("'" + tab + "'")}!${a1}` : a1;
}

async function sheetGet(spreadsheetId, tab, a1) {
  const range = rangeWithTab(tab, a1);
  const data = await gFetch("GET", SHEETS_HOST,
    `/v4/spreadsheets/${spreadsheetId}/values/${range}`);
  if (data.error) throw new Error("Sheets read error: " + JSON.stringify(data.error));
  return data.values || [];
}

async function sheetAppend(spreadsheetId, tab, a1, row) {
  const range = rangeWithTab(tab, a1);
  const data = await gFetch("POST", SHEETS_HOST,
    `/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { values: [row] });
  if (data.error) throw new Error("Sheets append error: " + JSON.stringify(data.error));
  return data;
}

async function sheetUpdate(spreadsheetId, tab, a1, values) {
  const range = rangeWithTab(tab, a1);
  const data = await gFetch("PUT", SHEETS_HOST,
    `/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    { values });
  if (data.error) throw new Error("Sheets update error: " + JSON.stringify(data.error));
  return data;
}

// ── Date helpers (America/Los_Angeles) ────────────────────────────────────────

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
}

function fmtDMon(d) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: TIMEZONE, day: "numeric", month: "short" })
    .formatToParts(d);
  const day = parts.find(p => p.type === "day").value;
  const mon = parts.find(p => p.type === "month").value;
  return `${day}-${mon}`;
}

// Parse a deadline cell into a YYYY-MM-DD-ish Date for comparison. Handles
// "YYYY-MM-DD", "4-Sep", "27-August". For year-less forms, pick the year that
// lands the date closest to today (within ±6 months), so reminders work.
function parseDeadline(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})/);
  if (m) {
    const day = +m[1];
    const monStr = m[2].slice(0, 3).toLowerCase();
    const monIdx = MONTHS.findIndex(x => x.toLowerCase() === monStr);
    if (monIdx < 0) return null;
    const now = new Date(todayISO() + "T00:00:00Z");
    const curYear = now.getUTCFullYear();
    let best = null, bestDiff = Infinity;
    for (const y of [curYear - 1, curYear, curYear + 1]) {
      const cand = new Date(Date.UTC(y, monIdx, day));
      const diff = Math.abs(cand - now);
      if (diff < bestDiff) { bestDiff = diff; best = cand; }
    }
    return best;
  }
  return null;
}

// ── Finance tools ─────────────────────────────────────────────────────────────

function normDirection(direction) {
  const d = (direction || "").toLowerCase();
  if (/(debo|i owe|yo (le )?debo|pagar yo|owe)/.test(d) && !/me deb/.test(d)) return "Debo yo";
  if (/(me deben|they owe|owes me|me debe)/.test(d)) return "Me deben";
  // Fallback on common short forms
  if (d.includes("debo")) return "Debo yo";
  return "Me deben";
}

async function add_debt({ name, reason = "", amount, currency = "USD", direction }) {
  if (!name || amount == null) return "Falta el nombre o el monto.";
  const today = todayISO();
  const dir = normDirection(direction);
  const row = [name, reason, today, amount, (currency || "USD").toUpperCase(), dir, "Por pagar", today];
  await sheetAppend(FINANCE_SHEET_ID, FINANCE_TAB, "A:H", row);
  const verbo = dir === "Debo yo" ? "Le debes" : "Te debe";
  return `✅ Registrado en Finanzas: ${verbo} ${amount} ${row[4]} — ${name}${reason ? " (" + reason + ")" : ""}. Estado: Por pagar.`;
}

async function list_debts({ filter = "pending" } = {}) {
  const rows = await sheetGet(FINANCE_SHEET_ID, FINANCE_TAB, "A2:H");
  const out = [];
  rows.forEach((r, i) => {
    const [name, reason, created, amount, currency, direction, status] = r;
    if (!name) return;
    const rowNum = i + 2; // header is row 1
    const st = (status || "").toLowerCase();
    const dir = (direction || "");
    const paid = st.includes("pagad");
    const passes =
      filter === "all" ? true :
      filter === "paid" ? paid :
      filter === "pending" ? !paid :
      filter === "me_deben" ? (!paid && /me deben/i.test(dir)) :
      filter === "debo_yo" ? (!paid && /debo/i.test(dir)) :
      !paid;
    if (!passes) return;
    out.push(`- ${name} — ${amount || "?"} ${currency || ""} — ${dir}${reason ? " — " + reason : ""} — ${status || "Por pagar"} [#${rowNum}]`);
  });
  if (out.length === 0) return `Sin deudas (${filter}).`;
  return `💰 Deudas (${filter}):\n` + out.join("\n");
}

async function update_debt_status({ row, status }) {
  if (!row) return "Falta el numero de fila [#].";
  const st = (status || "").toLowerCase();
  const newStatus = st.includes("pag") ? "Pagado" : "Por pagar";
  const today = todayISO();
  await sheetUpdate(FINANCE_SHEET_ID, FINANCE_TAB, `G${row}:H${row}`, [[newStatus, today]]);
  return `✅ Deuda fila ${row} → ${newStatus} (${today}).`;
}

// ── Networking tools ──────────────────────────────────────────────────────────

// Find the row to write a new contact: end of the contiguous block of names
// starting at row 2 (avoids the trailing empty "Late" rows and lower mini-tables).
async function networkInsertRow() {
  const colA = await sheetGet(NETWORK_SHEET_ID, NETWORK_TAB, "A2:A1000");
  let i = 0;
  while (i < colA.length && colA[i] && colA[i][0] && String(colA[i][0]).trim()) i++;
  return i + 2; // first empty row after the contiguous block
}

async function add_contact({ name, company = "", email = "", location = "US", how = "",
                             next_step = "", status = "🔵 Follow Up", next_step_deadline = "" }) {
  if (!name) return "Falta el nombre del contacto.";
  const today = fmtDMon(new Date());
  const row = [name, company, email, location, today, how, next_step, status, next_step_deadline, "Not yet"];
  const insertAt = await networkInsertRow();
  await sheetUpdate(NETWORK_SHEET_ID, NETWORK_TAB, `A${insertAt}:J${insertAt}`, [row]);
  return `✅ Agregado a Networking: ${name}${company ? " (" + company + ")" : ""}. Próximo paso: ${next_step || "—"}${next_step_deadline ? " — vence " + next_step_deadline : ""}. [#${insertAt}]`;
}

async function list_contacts({ filter = "due", query = "" } = {}) {
  const rows = await sheetGet(NETWORK_SHEET_ID, NETWORK_TAB, "A2:J1000");
  const today = new Date(todayISO() + "T00:00:00Z");
  const out = [];
  // Only walk the contiguous main block (stop at first empty Name).
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0];
    if (!name || !String(name).trim()) break;
    const rowNum = i + 2;
    const company = r[1] || "", status = r[7] || "", nextStep = r[6] || "", deadline = r[8] || "";
    if (filter === "search") {
      if (!String(name).toLowerCase().includes(query.toLowerCase())) continue;
    } else if (filter === "due") {
      const allSet = /all set/i.test(status);
      const d = parseDeadline(deadline);
      if (allSet) continue;
      if (!d || d > today) continue;
    } // filter === "all" → include everything in main block
    out.push(`- ${name}${company ? " (" + company + ")" : ""} — ${nextStep || "—"}${deadline ? " — vence " + deadline : ""}${status ? " — " + status : ""} [#${rowNum}]`);
  }
  if (out.length === 0) return `Sin contactos (${filter}).`;
  return `🤝 Networking (${filter}):\n` + out.join("\n");
}

async function update_contact({ row, next_step, status, next_step_deadline, last_contact }) {
  if (!row) return "Falta el numero de fila [#].";
  const updates = [];
  if (last_contact !== undefined)       updates.push([`E${row}`, last_contact === "today" ? fmtDMon(new Date()) : last_contact]);
  if (next_step !== undefined)          updates.push([`G${row}`, next_step]);
  if (status !== undefined)             updates.push([`H${row}`, status]);
  if (next_step_deadline !== undefined) updates.push([`I${row}`, next_step_deadline]);
  if (updates.length === 0) return "No hay cambios que aplicar.";
  for (const [cell, val] of updates) {
    await sheetUpdate(NETWORK_SHEET_ID, NETWORK_TAB, cell, [[val]]);
  }
  return `✅ Contacto fila ${row} actualizado.`;
}

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "add_debt",
    description: "Register a debt in the Finanzas ledger. Use when user says: le debo, me debe, alguien me debe, deuda, anota que debo, owe, debt. Confirm name + amount + currency + direction with the user before calling.",
    inputSchema: {
      type: "object",
      required: ["name", "amount", "direction"],
      properties: {
        name:      { type: "string", description: "Person's name" },
        reason:    { type: "string", description: "Free-text description of why (e.g. asado, paseo, fiesta)" },
        amount:    { type: "number", description: "Amount owed" },
        currency:  { type: "string", description: "Currency code, e.g. USD, CLP (default USD)" },
        direction: { type: "string", description: "'Me deben' (they owe Santiago) or 'Debo yo' (Santiago owes them)" }
      }
    }
  },
  {
    name: "list_debts",
    description: "List debts from the Finanzas ledger. Each line ends with [#N] which is the spreadsheet row id — use it for update_debt_status. NEVER use list position as the row id.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["pending", "paid", "me_deben", "debo_yo", "all"], description: "Default 'pending'." }
      }
    }
  },
  {
    name: "update_debt_status",
    description: "Mark a debt paid or pending. ALWAYS call list_debts first to get the [#N] row id. Sets the Status Changed date to today automatically.",
    inputSchema: {
      type: "object",
      required: ["row", "status"],
      properties: {
        row:    { type: "number", description: "Spreadsheet row id from list_debts [#N]" },
        status: { type: "string", description: "'Pagado' (paid) or 'Por pagar' (pending)" }
      }
    }
  },
  {
    name: "add_contact",
    description: "Add a person to the Networking tracker. Use when user says: agrega a networking, conoci a, agrega contacto, met someone, add to networking. Confirm details before calling. For 'talk again in N months/weeks' compute next_step_deadline from today.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name:               { type: "string", description: "Full name" },
        company:            { type: "string", description: "Company / org" },
        email:              { type: "string", description: "Email if known" },
        location:           { type: "string", description: "Location (default US)" },
        how:                { type: "string", description: "How you met / channel (e.g. ☕ Coffee Chat, 🎉 Event, 🤝 Intro)" },
        next_step:          { type: "string", description: "What to do next / notes about the person" },
        status:             { type: "string", description: "Status, e.g. '🔵 Follow Up', '🟡 Waiting', '✅ All Set' (default '🔵 Follow Up')" },
        next_step_deadline: { type: "string", description: "Deadline for next step, format YYYY-MM-DD" }
      }
    }
  },
  {
    name: "list_contacts",
    description: "List networking contacts. filter 'due' = follow-ups whose deadline has passed and are not All Set. Each line ends with [#N] (spreadsheet row id) — use it for update_contact. NEVER use list position as the row id.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["due", "all", "search"], description: "Default 'due'." },
        query:  { type: "string", description: "Name to search when filter='search'." }
      }
    }
  },
  {
    name: "update_contact",
    description: "Update a networking contact (next step, status, deadline, last contact). ALWAYS call list_contacts first to get the [#N] row id. Pass last_contact='today' to stamp today.",
    inputSchema: {
      type: "object",
      required: ["row"],
      properties: {
        row:                { type: "number", description: "Spreadsheet row id from list_contacts [#N]" },
        next_step:          { type: "string" },
        status:             { type: "string" },
        next_step_deadline: { type: "string", description: "YYYY-MM-DD" },
        last_contact:       { type: "string", description: "Date or 'today'" }
      }
    }
  }
];

const HANDLERS = { add_debt, list_debts, update_debt_status, add_contact, list_contacts, update_contact };

// ── MCP JSON-RPC server over stdio ────────────────────────────────────────────

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sheets-mcp", version: "1.0.0" } });
  }
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const { name, arguments: args } = params;
    if (!HANDLERS[name]) return error(id, -32601, `Unknown tool: ${name}`);
    try {
      const result = await HANDLERS[name](args || {});
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return reply(id, { content: [{ type: "text", text }] });
    } catch (err) {
      return error(id, -32603, err.message);
    }
  }
  if (method === "notifications/initialized") return;
  if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
