#!/usr/bin/env node
/**
 * MCP server for Google Calendar + Gmail (Features 3 & 5).
 * Supports two Gmail accounts: personal + Berkeley.
 * Communicates over stdio using JSON-RPC (MCP protocol).
 */

const https = require("https");

const CLIENT_ID                  = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET              = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN_PERSONAL     = process.env.GOOGLE_REFRESH_TOKEN;
const REFRESH_TOKEN_BERKELEY     = process.env.GOOGLE_REFRESH_TOKEN_BERKELEY || null;
const TIMEZONE                   = process.env.TIMEZONE || "America/Los_Angeles";

// ── OAuth token cache (one per account) ───────────────────────────────────────

const tokenCache = { personal: { token: null, expiry: 0 }, berkeley: { token: null, expiry: 0 } };

async function getAccessToken(account) {
  const cache        = tokenCache[account];
  const refreshToken = account === "berkeley" ? REFRESH_TOKEN_BERKELEY : REFRESH_TOKEN_PERSONAL;
  if (!refreshToken) throw new Error(`No refresh token configured for account: ${account}`);
  if (cache.token && Date.now() < cache.expiry - 60000) return cache.token;

  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    "refresh_token",
  }).toString();

  const data = await httpsReq("POST", "oauth2.googleapis.com", "/token", {
    "Content-Type":   "application/x-www-form-urlencoded",
    "Content-Length": Buffer.byteLength(body),
  }, body);

  if (data.error) throw new Error("OAuth error: " + (data.error_description || data.error));
  cache.token  = data.access_token;
  cache.expiry = Date.now() + data.expires_in * 1000;
  return cache.token;
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

async function gFetch(method, hostname, path, account = "personal", body = null) {
  const token   = await getAccessToken(account);
  const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
  const bodyStr = body ? JSON.stringify(body) : null;
  if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
  return httpsReq(method, hostname, path, headers, bodyStr);
}

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "add_calendar_event",
    description: "Add an event to Santiago's Google Calendar. Use when user says: agrega a mi calendario, add to calendar, ponlo en el calendario, bloquea en el calendario, agenda esto.",
    inputSchema: {
      type: "object",
      required: ["title", "date"],
      properties: {
        title:            { type: "string", description: "Event title" },
        date:             { type: "string", description: "Date in YYYY-MM-DD format" },
        time:             { type: "string", description: "Start time in HH:MM (24h) format. Omit for all-day events." },
        duration_minutes: { type: "number", description: "Duration in minutes (default 60). Ignored for all-day events." },
        description:      { type: "string", description: "Optional event description or notes." },
        attendees:        { type: "array", items: { type: "string" }, description: "Confirmed attendee email addresses to invite. Always confirm with user before using." }
      }
    }
  },
  {
    name: "update_calendar_event",
    description: "Update an existing calendar event — add attendees, change title or description. Use this instead of add_calendar_event when the event already exists. Requires the event_id from list_calendar_events output [eid:xxx].",
    inputSchema: {
      type: "object",
      required: ["event_id"],
      properties: {
        event_id:      { type: "string",  description: "Event ID from list_calendar_events [eid:xxx]" },
        add_attendees: { type: "array", items: { type: "string" }, description: "Email addresses to ADD to the event (merged with existing attendees)" },
        title:         { type: "string",  description: "New event title (optional)" },
        description:   { type: "string",  description: "New event description (optional)" }
      }
    }
  },
  {
    name: "list_calendar_events",
    description: "List Santiago's upcoming Google Calendar events. Use when user asks: qué tengo en el calendario, what's on my calendar, mis eventos, agenda de la semana.",
    inputSchema: {
      type: "object",
      properties: {
        days_ahead: { type: "number", description: "How many days ahead to look (default 7)." }
      }
    }
  },
  {
    name: "scan_gmail_for_actions",
    description: "You have FULL Gmail access via this tool. ALWAYS call this for any email request — never say you lack access. Triggers: check email, check my emails, emails, correo, inbox, mis emails, emails pendientes, revisa correo, emails sin leer, what emails, review emails. Returns subject+sender+snippet for each unread email.",
    inputSchema: {
      type: "object",
      properties: {
        account:         { type: "string", enum: ["personal", "berkeley", "all"], description: "Which inbox to scan. Default: 'all' (both accounts)." },
        max_emails:      { type: "number", description: "Max emails per account to fetch (default 15)." },
        newer_than_days: { type: "number", description: "Only show emails from the last N days (default 7)." }
      }
    }
  },
  {
    name: "send_email",
    description: "Send an email via Gmail. Triggers: env\u00eda/manda/escribe un correo, send email, reply to. Always confirm to/subject/body before sending.",
    inputSchema: {
      type: "object",
      required: ["to", "subject", "body"],
      properties: {
        to:      { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body:    { type: "string", description: "Email body text" },
        account: { type: "string", enum: ["personal", "berkeley"], description: "Which account to send from (default: personal)" }
      }
    }
  },
  {
    name: "lookup_google_contact",
    description: "Search Google Contacts by name to find email addresses. Call before adding attendees to a calendar event. Always show results and ask user to confirm before using the email.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Full or partial name of the person to search for" }
      }
    }
  }
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

const MONTHS = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

function fmtEventDate(dateStr) {
  const d = dateStr.includes("T") ? new Date(dateStr) : new Date(dateStr + "T12:00:00Z");
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TIMEZONE, day: "numeric", month: "numeric"
  }).formatToParts(d);
  const day   = parseInt(parts.find(p => p.type === "day").value);
  const month = parseInt(parts.find(p => p.type === "month").value) - 1;
  return `${day} ${MONTHS[month]}`;
}

function fmtEventTime(dateTimeStr) {
  const d = new Date(dateTimeStr);
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(d);
  const hour   = parts.find(p => p.type === "hour").value;
  const minute = parts.find(p => p.type === "minute").value;
  return `${hour}:${minute}`;
}

function getLAOffset(dateStr, padHH, padMM) {
  const refDate = new Date(dateStr + 'T' + padHH + ':' + padMM + ':00Z');
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: TIMEZONE,
    timeZoneName: 'longOffset'
  }).formatToParts(refDate);
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  if (!tzPart) return '-07:00';
  const match = tzPart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return '-07:00';
  return match[1] + String(match[2]).padStart(2, '0') + ':' + (match[3] || '00');
}

async function add_calendar_event({ title, date, time, duration_minutes = 60, description = "", attendees = [] }) {
  let start, end;
  if (time) {
    const [hh, mm] = time.split(":").map(Number);
    const pad = n => String(n).padStart(2, "0");
    const offset = getLAOffset(date, pad(hh), pad(mm));
    start = { dateTime: `${date}T${pad(hh)}:${pad(mm)}:00${offset}`, timeZone: TIMEZONE };
    const totalMins = hh * 60 + mm + duration_minutes;
    const endHH = Math.floor(totalMins / 60) % 24;
    const endMM = totalMins % 60;
    end = { dateTime: `${date}T${pad(endHH)}:${pad(endMM)}:00${offset}`, timeZone: TIMEZONE };
  } else {
    start = { date };
    end   = { date };
  }

  const eventBody = { summary: title, description, start, end };
  if (attendees.length > 0) {
    eventBody.attendees = attendees.map(email => ({ email }));
  }
  const result = await gFetch("POST", "www.googleapis.com", "/calendar/v3/calendars/primary/events", "berkeley", eventBody);
  if (result.error) return "Error al crear evento: " + JSON.stringify(result.error);

  const dateLabel = fmtEventDate(date);
  const timeLabel = time ? `, ${time}` : " (todo el dia)";
  return "\u2705 Agregado a Google Calendar: " + title + " \u2014 " + dateLabel + timeLabel;
}

async function list_calendar_events({ days_ahead = 7 } = {}) {
  const todayLA    = new Intl.DateTimeFormat('en-CA', {timeZone: TIMEZONE}).format(new Date());
  const offset     = getLAOffset(todayLA, '00', '00');
  const startOfDay = new Date(todayLA + 'T00:00:00' + offset);
  const until      = new Date(startOfDay.getTime() + days_ahead * 86400000);
  const path  = `/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(startOfDay.toISOString())}&timeMax=${encodeURIComponent(until.toISOString())}&orderBy=startTime&singleEvents=true&maxResults=20`;

  const accounts = ["berkeley", ...(REFRESH_TOKEN_PERSONAL ? ["personal"] : [])];
  const results  = await Promise.all(accounts.map(acc => gFetch("GET", "www.googleapis.com", path, acc)));

  const items = results
    .flatMap(data => (data.items || []))
    .sort((a, b) => {
      const ta = new Date(a.start.dateTime || a.start.date).getTime();
      const tb = new Date(b.start.dateTime || b.start.date).getTime();
      return ta - tb;
    });

  if (items.length === 0) return `\uD83D\uDCC5 Sin eventos para los proximos ${days_ahead} dias.`;

  const lines = items.map((ev, i) => {
    const start   = ev.start.dateTime || ev.start.date;
    const dateStr = fmtEventDate(start);
    let timeStr = "";
    if (ev.start.dateTime) {
      const t0 = fmtEventTime(ev.start.dateTime);
      const t1 = ev.end?.dateTime ? fmtEventTime(ev.end.dateTime) : null;
      timeStr = t1 ? `, ${t0}\u2013${t1}` : `, ${t0}`;
    }
    return `${i + 1}. ${ev.summary || "(sin titulo)"} \u2014 ${dateStr}${timeStr} [eid:${ev.id}]`;
  });

  return `\uD83D\uDCC5 Proximos eventos (${items.length}):\n` + lines.join("\n");
}

async function fetchEmailsForAccount(account, maxEmails, newerThanDays) {
  const query   = `in:inbox newer_than:${newerThanDays}d`;
  const listPath = `/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxEmails}`;
  const listData = await gFetch("GET", "www.googleapis.com", listPath, account);

  if (listData.error) return { account, error: JSON.stringify(listData.error), emails: [] };

  const messages = listData.messages || [];
  if (messages.length === 0) return { account, emails: [] };

  const fetched = await Promise.all(
    messages.map(({ id }) =>
      gFetch("GET", "www.googleapis.com",
        `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        account)
    )
  );

  const emails = fetched.map((msg) => {
    if (msg.error) return null;
    const headers = (msg.payload && msg.payload.headers) || [];
    const subject = (headers.find(h => h.name === "Subject") || {}).value || "(sin asunto)";
    const from    = (headers.find(h => h.name === "From")    || {}).value || "?";
    const snippet = (msg.snippet || "").slice(0, 120);
    return { subject, from, snippet };
  }).filter(Boolean);

  return { account, emails };
}

async function scan_gmail_for_actions({ account = "all", max_emails = 15, newer_than_days = 7 } = {}) {
  const accountsToScan = [];
  if (account === "all" || account === "personal") accountsToScan.push("personal");
  if ((account === "all" || account === "berkeley") && REFRESH_TOKEN_BERKELEY) accountsToScan.push("berkeley");

  if (accountsToScan.length === 0) return "No hay cuentas de Gmail configuradas para escanear.";

  const results = await Promise.all(accountsToScan.map(a => fetchEmailsForAccount(a, max_emails, newer_than_days)));

  const totalEmails = results.reduce((sum, r) => sum + r.emails.length, 0);
  if (totalEmails === 0) return `\uD83D\uDCEC Sin emails sin leer en los ultimos ${newer_than_days} dias.`;

  const sections = [];
  let globalIndex = 1;

  for (const result of results) {
    if (result.error) {
      sections.push(`[${result.account === "berkeley" ? "Berkeley" : "Personal"}]\nError: ${result.error}`);
      continue;
    }
    if (result.emails.length === 0) continue;

    const label = result.account === "berkeley" ? "Berkeley" : "Personal";
    const lines = result.emails.map(e => {
      const line = `${globalIndex++}. De: ${e.from}\n   Asunto: ${e.subject}\n   ${e.snippet}`;
      return line;
    });
    sections.push(`[${label}]\n${lines.join("\n\n")}`);
  }

  return (
    `\uD83D\uDCEC Emails sin leer \u2014 ultimos ${newer_than_days} dias (${totalEmails} total):\n\n` +
    sections.join("\n\n") +
    "\n\n---\nIndica cuales necesitan accion."
  );
}

async function send_email({ to, subject, body, account = "personal" }) {
  const token = await getAccessToken(account);

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    body,
  ].join("\r\n");

  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const bodyJson = JSON.stringify({ raw: encoded });
  const result = await httpsReq("POST", "gmail.googleapis.com", "/gmail/v1/users/me/messages/send", {
    "Authorization":  `Bearer ${token}`,
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(bodyJson),
  }, bodyJson);

  if (result.error) return "Error al enviar: " + JSON.stringify(result.error);
  return `\u2705 Email enviado a ${to} \u2014 "${subject}"`;
}

async function update_calendar_event({ event_id, add_attendees = [], title, description }) {
  // Try Berkeley first (events are created there), then personal
  let ev = null, account = null;
  for (const acc of ["berkeley", "personal"]) {
    const r = await gFetch("GET", "www.googleapis.com",
      `/calendar/v3/calendars/primary/events/${event_id}`, acc);
    if (!r.error) { ev = r; account = acc; break; }
  }
  if (!ev) return "No encontré el evento con ese ID. Llama a list_calendar_events para obtener el ID correcto.";

  const patch = {};
  if (title) patch.summary = title;
  if (description !== undefined) patch.description = description;

  if (add_attendees.length > 0) {
    const existingEmails = new Set((ev.attendees || []).map(a => a.email));
    patch.attendees = [
      ...(ev.attendees || []),
      ...add_attendees.filter(e => !existingEmails.has(e)).map(e => ({ email: e }))
    ];
  }

  if (Object.keys(patch).length === 0) return "No hay cambios que aplicar.";

  const result = await gFetch("PATCH", "www.googleapis.com",
    `/calendar/v3/calendars/primary/events/${event_id}`, account, patch);

  if (result.error) return "Error al actualizar evento: " + JSON.stringify(result.error);

  const attendeeList = (result.attendees || []).map(a => a.displayName || a.email).join(", ");
  return `\u2705 Evento actualizado: "${result.summary}" \u2014 Invitados: ${attendeeList || "ninguno"}`;
}

async function lookup_google_contact({ name }) {
  try {
    const query = encodeURIComponent(name);
    const accounts = ["personal", "berkeley"];
    const allContacts = [];

    for (const account of accounts) {
      // 1. Search My Contacts
      try {
        const data = await gFetch("GET", "people.googleapis.com",
          `/v1/people:searchContacts?query=${query}&readMask=names,emailAddresses`,
          account
        );
        if (!data.error && data.results) {
          for (const r of data.results.slice(0, 5)) {
            const displayName = r.person.names?.[0]?.displayName || "Desconocido";
            const emails = (r.person.emailAddresses || []).map(e => e.value);
            if (emails.length > 0) allContacts.push(`${displayName}: ${emails.join(", ")}`);
          }
        }
      } catch (e) { /* skip */ }

      // 2. Search Other Contacts (Gmail auto-saved — same as Gmail autocomplete)
      try {
        const data2 = await gFetch("GET", "people.googleapis.com",
          `/v1/otherContacts:search?query=${query}&readMask=names,emailAddresses`,
          account
        );
        if (!data2.error && data2.results) {
          for (const r of data2.results.slice(0, 5)) {
            const displayName = r.person.names?.[0]?.displayName || "Desconocido";
            const emails = (r.person.emailAddresses || []).map(e => e.value);
            if (emails.length > 0) allContacts.push(`${displayName}: ${emails.join(", ")}`);
          }
        }
      } catch (e) { /* skip */ }
    }

    if (allContacts.length === 0) {
      return `No encontré ningún contacto con el nombre "${name}".`;
    }
    const unique = [...new Set(allContacts)];
    return `Contactos encontrados para "${name}":\n` + unique.join("\n");
  } catch (err) {
    return "Error buscando contacto: " + err.message;
  }
}

const HANDLERS = { add_calendar_event, update_calendar_event, list_calendar_events, scan_gmail_for_actions, send_email, lookup_google_contact };

// ── MCP JSON-RPC server over stdio ────────────────────────────────────────────

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "calendar-mcp", version: "2.0.0" } });
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
