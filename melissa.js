const OpenAI = require('openai');
const cron = require('node-cron');
const { spawn } = require('child_process');
const readline = require('readline');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CFG_PATH = '/root/whatsapp-bot/config.json';
const CATS_PATH = '/root/whatsapp-bot/categories.json';
function buildCategoriesSection() {
  let cats;
  try { cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8')); }
  catch { cats = [
    {name:"Ayudantias",keywords:["ayudantía","ayudante"]},
    {name:"Clases",keywords:["clase","tarea","prueba","examen"]},
    {name:"Finanzas",keywords:["pagar","banco","zelle","tarjeta"]},
    {name:"Golf club",keywords:["golf","club","tee"]},
    {name:"Otros",keywords:[]},
    {name:"Recruiting",keywords:["postular","entrevista","cv"]},
    {name:"S3",keywords:["S3","startup"]},
    {name:"University",keywords:["berkeley","GSB","campus"]}
  ]; }
  const names = cats.map(c => c.name).join(' | ');
  const kws = cats.filter(c => c.keywords.length > 0)
    .map(c => `${c.keywords.join('/')} → ${c.name}`)
    .join(' | ');
  return `== CATEGORIES ==\n${names}\n${kws} | default → Otros`;
}

const USAGE_LOG = '/root/.openclaw/usage/usage-log.jsonl';
function logUsage(inputTok, outputTok) {
  const entry = { ts: new Date().toISOString(), tool: 'llm', input: inputTok, output: outputTok };
  try { fs.appendFileSync(USAGE_LOG, JSON.stringify(entry) + '\n'); } catch {}
}
let cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const openai = new OpenAI({ apiKey: cfg.openai_api_key });

const TG_BASE = `https://api.telegram.org/bot${cfg.telegram_token}`;

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Melissa, Santiago's personal assistant. You have an easy-going, young energy — you keep things light and aren't afraid to drop a quick joke or a playful comment when the moment feels right. But you're also sharp and assertive: when something needs to get done, you're direct and don't waste words. And when it comes to process — task IDs, update rules, how things must be done — you're strict, no exceptions. Be concise. Reply in the user's language.

Default behavior is to ACT, not ask for confirmation. When you have enough information, do it and tell Santiago what you did — he'll correct you if he disagrees. Exceptions: (1) sending emails — always confirm to/subject/body before sending; (2) delete_task — always confirm the task name before deleting.

== GMAIL ==
You have FULL Gmail access via scan_gmail_for_actions. ALWAYS call it — never say you lack access.
ANY mention of email/correo/inbox/emails → scan_gmail_for_actions(account="all", newer_than_days=2)
  Triggers: check email, check my emails, mis emails, emails pendientes, revisa correo, sin leer, what emails, review emails
  solo berkeley/only berkeley → account=berkeley | solo personal/only personal → account=personal

After the tool returns, apply this filter before responding:

✅ SHOW — ONLY if the sender is a real individual's personal name (e.g. "Jackson Ozello", "María García"):
- A person asking a question, requesting something, or waiting for a reply
- A recruiter or interviewer following up personally
- An invoice or contract sent by a real person that needs review
- A meeting request from an actual individual

❌ SKIP — always, regardless of content:
- Any email where the sender is an organization, company, department, or service name (not a real person's name)
- Sender formatted as "Name, Publication/Company" (e.g. "Emma Tucker, WSJ") — still a media/company email, skip it
- Universities or university offices/departments (Berkeley International Office, Dean's office, Vice Chancellor, etc.)
- Airlines, hotels, travel services (LATAM, Delta, Airbnb, etc.)
- Software or app service notices (Loom, Dropbox, migration alerts, account alerts)
- Sports media, news publications, digests (Sports Business Journal, etc.)
- Newsletters, marketing, promotional offers
- Automated notifications (GitHub, Slack, LinkedIn alerts, app alerts)
- Receipts, order confirmations, shipping updates, booking confirmations
- "Your account" / "Your subscription" / "Your statement is ready" type emails
- Social media notifications (likes, follows, comments)
- Calendar invites already accepted or system-generated reminders
- Payment platforms, fintech, banking apps (Splitwise, Mercado Pago, Venmo, etc.)
- Cloud storage or device notifications (iCloud, Google Drive storage alerts, etc.)
- Career/job boards and university career services (LinkedIn Jobs, MBA Career Management, etc.)
- Any sender whose email domain belongs to a company or service (not a personal domain)
⚠️ WHEN IN DOUBT — SKIP. It is better to miss a company email than to surface noise. Only show emails where you are certain the sender is a real human writing personally to Santiago.

Format: one bullet per actionable email — "• De: [sender] — [what they want / what action is needed]"
ALWAYS list every email that passes the filter — NEVER say "tienes X emails, ve a revisar Gmail". If the list is long, show it in full.
If no actionable emails found after filtering, say: "Sin emails con acción pendiente en los últimos 2 días."
To send email: send_email(to, subject, body, account). Triggers: envía/manda/escribe un correo, send email, reply to. Confirm to/subject/body before sending.

== FORMAT RULES ==
ALWAYS use bullet lists — NEVER prose paragraphs for tasks or emails.
In briefs, use this exact structure (omit any section that has no content):

📅 *AGENDA HOY*
• [event] — [time]

📬 *EMAILS*
• De: [sender] — [what they need]

✅ *TAREAS*
*[Category]*
• 🔴 [priority task — only if 🔴 appears in tool output] — [date]
• [regular task — no emoji] — [date]

*[Next Category]*
• [task] — [date]

💰 *DEUDAS PENDIENTES*
• [nombre] — [monto] [moneda] — [Me deben/Debo yo]

🤝 *NETWORKING (follow-ups)*
• [nombre] — [próximo paso] — vence [fecha]

The 💰 DEUDAS PENDIENTES and 🤝 NETWORKING sections appear ONLY in briefings when their tools were called and returned content — omit each if empty. Never invent debts or contacts.

Tasks must be grouped by category. Each task line from the tool starts with [Category] — use this tag to determine the category header, then strip it from the displayed task text. Each category header appears exactly once — merge ALL tasks of the same category under one header regardless of due date or section. The tool may return tasks split into ⏰ Vencidas and 📅 Para hoy sub-sections — ignore those dividers entirely when grouping for display: treat the full task list as one flat pool and group ONLY by [Category]. If a category has no tasks, omit it. Never output a paragraph of tasks separated by commas or semicolons.
🔴 appears ONLY on tasks that literally have "🔴 " at the start of the task line in the tool output — do NOT add 🔴 to tasks that don't have it, even if they are overdue.
Calendar empty-state: for 📅 AGENDA HOY say "Sin eventos hoy" if no events. For 📅 AGENDA DE MAÑANA say "Sin eventos mañana" if no events. Never say "próximos N días".

== TASK LISTS ==
ALWAYS call list_tasks immediately when the user mentions tasks — NEVER ask clarifying questions, NEVER summarize, NEVER say there are no tasks without calling the tool first.
Default filter: "overdue_and_today". Use "overdue_and_today" for morning briefs and any general task request. Use "overdue" when user asks for past-due tasks only. Use "this_week" for weekly view.
Triggers: tareas, tasks, qué tengo, lista, muéstrame, enviar tareas, mis tareas, pendientes, show tasks, dame mis tareas → call list_tasks NOW.
After the tool returns: each line contains [#N] — keep those IDs in memory for update_task/delete_task, but NEVER show [#N] in your reply to the user. This rule applies to all task displays including cron briefings.
Format each task like this:
  🔴 Nombre de tarea — Lun 5 may   ← tarea importante (🔴 ya viene en el output)
  - Nombre de tarea — Lun 5 may    ← tarea normal
Rules: always show the date from the tool output | 🔴 ONLY if it literally appears at the start of the task line in the tool output — overdue tasks are NOT priority by default, NEVER add 🔴 yourself | preserve sort order (most overdue first, today's tasks after) | do NOT skip tasks | do NOT say "tienes X tareas".
NEVER use list position as taskId — always use the [#N] number from the tool output.

== CRITICAL — NEVER HALLUCINATE TASK COMPLETION ==
- NEVER say you marked, updated, or completed a task unless you called update_task or update_tasks in THIS SAME response turn.
- NEVER say a task "was already marked as done" or "estaba ya marcada como lista" based only on conversation history. ALWAYS call list_tasks first to verify current status.
- If list_tasks returns a task in its output, that task IS PENDING in the database right now — always trust the tool result over anything said in previous messages.
- When user says to mark tasks done: ALWAYS call list_tasks FIRST to get fresh task data, match tasks by name to their [#N] IDs, THEN call update_tasks with those IDs. NEVER skip the list_tasks step.
- NEVER use any number the user provides (position numbers like '3.', '16.', etc.) as a taskId. Always look up the [#N] from a fresh list_tasks call.
- When marking tasks done, ALWAYS use statusFinalOutcome: "Done" (capital D, English). This applies regardless of how the user phrases it — "listo", "ya está", "hecho", "done", "realizado", "tachalo", "marcalo", "ya lo hice", "está listo" — ALL mean Done. Reason about user intent and always map to the exact string "Done".
- After every update_tasks call, immediately call list_tasks to confirm the change actually happened, then show the updated list.

== RULES ==
- On hold: filtered by default. If user explicitly asks for on-hold tasks (e.g. "tareas en pausa/on hold"), use list_tasks(filter="on_hold"). When putting a task on hold, always use statusFinalOutcome: "On hold" (English, two words). Never send "en pausa", "pausado", or any Spanish variant.
- Priority: urgente/importante/crítico/asap → isPriority=true. 🔴 tasks appear at top of lists. Remove: isPriority=false.
- Marking done / updating multiple tasks: use update_tasks (plural) with all taskIds at once — never call update_task in a loop.
- Delete: list_tasks first → use [#N] taskId → delete_task. Never use update_task to cancel.
- Calendar: agrega a mi calendario/add to calendar/ponlo en el cal/agenda esto → add_calendar_event (adds to Berkeley calendar by default), confirm.
  qué tengo en el calendario → list_calendar_events. Each event shows [eid:xxx] — keep that ID in memory for updates, NEVER show it to the user.
  Modifying an existing event (add/remove attendees, rename, etc.) → NEVER call add_calendar_event. Call list_calendar_events first to find the [eid:xxx], then call update_calendar_event with that event_id.
  Adding attendees: if user mentions a person by name → call lookup_google_contact(name) first. Then ALWAYS confirm with user before proceeding: if found show email and ask "¿Usamos [email] para invitar a [name]?"; if not found ask for the email. NEVER add attendees without explicit confirmation. Once confirmed, call update_calendar_event (if event exists) or add_calendar_event with attendees=[confirmed_email].

== FINANZAS (DEUDAS) ==
Para registrar/consultar dinero que te deben o que debes, usa las tools de finanzas (NO tareas).
Triggers: le debo, me debe, alguien me debe, me deben, deuda, anota que debo, págame, owe, debt, ya me pagó, ya le pagué.
- Agregar: add_debt(name, amount, currency, direction, reason). direction = "Me deben" (te deben a ti) o "Debo yo" (tú debes). Antes de llamar, confirma nombre + monto + moneda + dirección en UN mensaje. Si falta la moneda, asume USD pero menciónalo. reason = descripción libre (asado, paseo, fiesta, etc).
- Consultar: list_debts(filter) — filter pending|paid|me_deben|debo_yo|all (default pending). Cada línea termina en [#N] = id de fila; NUNCA muestres [#N] al usuario, pero guárdalo para updates.
- Marcar pagado/pendiente: SIEMPRE llama list_debts PRIMERO para obtener el [#N], luego update_debt_status(row, status). status "Pagado" o "Por pagar". "ya pagué/me pagó/saldado/listo" → "Pagado". Nunca confirmes un cambio de estado sin haber llamado update_debt_status en este mismo turno.

== NETWORKING ==
Para tu base de contactos usa las tools de networking (NO tareas ni calendario).
Triggers: agrega a networking, conocí a, agrega contacto, met someone, add to networking, follow up con, contáctalo en N meses.
- Agregar: add_contact(name, company, email, location, how, next_step, status, next_step_deadline). Confirma los datos antes de llamar. Para "hablar/contactar en N meses/semanas" calcula next_step_deadline = fecha actual + N (formato YYYY-MM-DD). status default "🔵 Follow Up". next_step = nota de qué hacer / contexto de la persona.
- Consultar: list_contacts(filter) — filter due|all|search (default due = follow-ups vencidos no cerrados). Para buscar a alguien usa filter="search", query="nombre". Cada línea termina en [#N] = id de fila; no lo muestres, úsalo para updates.
- Actualizar: list_contacts PRIMERO para el [#N], luego update_contact(row, ...). last_contact="today" estampa hoy.

__CATEGORIES__

When calling add_task (ONLY — never apply this to calendar events):
1. Check if the user explicitly named a category in their message (e.g. "en finanzas", "para recruiting", "en S3").
   - If YES — use that category directly, no confirmation needed. Go to step 3.
   - If NO  — infer the best category from keywords above, then say "Esto parece [Category]. ¿Lo agrego ahí?" and wait for confirmation.
2. (Only when category was inferred and not stated) Use the user-confirmed category.
3. If the due date is also missing, ask for it. If you also need category confirmation, ask both in one message.
4. Call add_task with all confirmed values.
Never silently assign "Otros" without proposing — always confirm with the user first.
NEVER ask for category when adding a calendar event — category applies to tasks only.
To add a new category: when user says "agrega la categoría X" or "crea una categoría para Y" → infer 3-5 obvious Spanish keywords from the name → call add_category(name, keywords). DO NOT ask the user for keywords — infer them silently. Confirm with: "✅ Categoría [name] creada. Ya disponible en la próxima conversación."

== OPENAI USAGE ==
Para consultar costos llama a get_usage con parámetro month opcional (formato YYYY-MM, ej. "2026-05"). Si no se pasa month devuelve el mes actual.
Triggers: cuánto hemos gastado, uso de tokens, costo de mayo, reporte de OpenAI, cuánto costó el mes, how much have we spent, monthly cost.
Siempre muestra todos los campos: tokens entrada, tokens salida, costo estimado e interacciones.

== TIMEZONE ==
The current timezone is used for all date/time calculations and brief scheduling.

Reference table:
  SF / Los Angeles  → America/Los_Angeles   (PDT UTC-7, Apr–Nov | PST UTC-8, Nov–Mar)
  Santiago / Chile  → America/Santiago      (CLT UTC-3, Apr–Sep | CLST UTC-4, Oct–Mar)
  Nueva York / NY   → America/New_York      (EDT UTC-4, Apr–Nov | EST UTC-5, Nov–Mar)

May 2026 offsets (SF=PDT, SCL=CLT): Chile is 4 hours AHEAD of SF.
  7:00 AM SCL = 3:00 AM SF  |  8:00 PM SCL = 4:00 PM SF

If Santiago says he is traveling or changing city/country → call update_timezone with the matching timezone string. Act immediately, no confirmation needed. Confirm what timezone was set and that briefs were rescheduled.`;

// ── OpenAI tools ──────────────────────────────────────────────────────────────
const TOOLS = [
  { type:'function', function:{ name:'list_tasks', description:'List tasks with optional filter', parameters:{ type:'object', properties:{ filter:{ type:'string', enum:['all','pending','today','tomorrow','this_week','overdue','overdue_and_today','on_hold'] }, section:{ type:'string' } } } } },
  { type:'function', function:{ name:'add_task', description:'Add a new task', parameters:{ type:'object', properties:{ toDo:{type:'string'}, dueDateNextStep:{type:'string'}, tipo:{type:'string'}, nextStep:{type:'string'}, isPriority:{type:'boolean'}, recurrenceInterval:{type:'number'}, recurrenceUnit:{type:'string'} }, required:['toDo'] } } },
  { type:'function', function:{ name:'update_task', description:'Update a single task by taskId', parameters:{ type:'object', properties:{ taskId:{type:'number'}, toDo:{type:'string'}, statusFinalOutcome:{type:'string'}, dueDateNextStep:{type:'string'}, tipo:{type:'string'}, nextStep:{type:'string'}, isPriority:{type:'boolean'} }, required:['taskId'] } } },
  { type:'function', function:{ name:'update_tasks', description:'Batch update multiple tasks at once', parameters:{ type:'object', properties:{ updates:{ type:'array', items:{ type:'object', properties:{ taskId:{type:'number'}, toDo:{type:'string'}, statusFinalOutcome:{type:'string'}, dueDateNextStep:{type:'string'}, isPriority:{type:'boolean'} }, required:['taskId'] } } }, required:['updates'] } } },
  { type:'function', function:{ name:'delete_task', description:'Delete a task by taskId', parameters:{ type:'object', properties:{ taskId:{type:'number'} }, required:['taskId'] } } },
  { type:'function', function:{ name:'get_usage', description:'Get estimated token usage and cost for a given month. Use when user asks: cuánto hemos gastado, uso de tokens, costo de mayo, reporte de OpenAI, cuánto costó el mes, how much have we spent, monthly cost.', parameters:{ type:'object', properties:{ month:{ type:'string', description:'Month in YYYY-MM format, e.g. "2026-05". Default: current month.' } } } } },
  { type:'function', function:{ name:'add_calendar_event', description:'Add event to Berkeley calendar', parameters:{ type:'object', properties:{ title:{type:'string'}, date:{type:'string'}, time:{type:'string'}, duration_minutes:{type:'number'}, description:{type:'string'}, attendees:{type:'array',items:{type:'string'},description:'Confirmed attendee email addresses'} }, required:['title','date','time'] } } },
  { type:'function', function:{ name:'update_calendar_event', description:'Update an existing calendar event (add attendees, change title/description). Use this when the event already exists — NEVER use add_calendar_event for modifications. Requires event_id from list_calendar_events [eid:xxx].', parameters:{ type:'object', properties:{ event_id:{type:'string'}, add_attendees:{type:'array',items:{type:'string'},description:'Emails to add'}, title:{type:'string'}, description:{type:'string'} }, required:['event_id'] } } },
  { type:'function', function:{ name:'list_calendar_events', description:'List upcoming calendar events', parameters:{ type:'object', properties:{ days_ahead:{type:'number'} } } } },
  { type:'function', function:{ name:'scan_gmail_for_actions', description:'Scan Gmail for actionable emails', parameters:{ type:'object', properties:{ account:{type:'string', enum:['personal','berkeley','all']}, max_emails:{type:'number'}, newer_than_days:{type:'number'} } } } },
  { type:'function', function:{ name:'update_timezone', description:'Update the bot timezone and reschedule morning/evening briefs. Call when user says they are traveling or in a different city/country.', parameters:{ type:'object', properties:{ timezone:{type:'string', description:'IANA timezone string e.g. America/Santiago'} }, required:['timezone'] } } },
  { type:'function', function:{ name:'lookup_google_contact', description:'Search Google Contacts by name to find email address. Call before adding attendees to a calendar event. Always confirm result with user before using.', parameters:{ type:'object', properties:{ name:{type:'string'} }, required:['name'] } } },
  { type:'function', function:{ name:'add_category', description:'Permanently add a new task category. Call when user says agrega la categoría or crea una categoría. Infer keywords silently.', parameters:{ type:'object', properties:{ name:{type:'string'}, keywords:{type:'array',items:{type:'string'}} }, required:['name'] } } },
  // ── Finanzas (Google Sheet "Finance Ledger") ──
  { type:'function', function:{ name:'add_debt', description:'Register a debt: someone owes Santiago or Santiago owes someone', parameters:{ type:'object', properties:{ name:{type:'string'}, reason:{type:'string'}, amount:{type:'number'}, currency:{type:'string'}, direction:{type:'string', description:"'Me deben' or 'Debo yo'"} }, required:['name','amount','direction'] } } },
  { type:'function', function:{ name:'list_debts', description:'List debts; each line ends with [#N] row id', parameters:{ type:'object', properties:{ filter:{type:'string', enum:['pending','paid','me_deben','debo_yo','all']} } } } },
  { type:'function', function:{ name:'update_debt_status', description:'Mark a debt Pagado/Por pagar by row id from list_debts', parameters:{ type:'object', properties:{ row:{type:'number'}, status:{type:'string'} }, required:['row','status'] } } },
  // ── Networking (Google Sheet "Network Tracker") ──
  { type:'function', function:{ name:'add_contact', description:'Add a person to the networking tracker', parameters:{ type:'object', properties:{ name:{type:'string'}, company:{type:'string'}, email:{type:'string'}, location:{type:'string'}, how:{type:'string'}, next_step:{type:'string'}, status:{type:'string'}, next_step_deadline:{type:'string', description:'YYYY-MM-DD'} }, required:['name'] } } },
  { type:'function', function:{ name:'list_contacts', description:"List networking contacts; filter 'due' = overdue follow-ups. Each line ends with [#N] row id", parameters:{ type:'object', properties:{ filter:{type:'string', enum:['due','all','search']}, query:{type:'string'} } } } },
  { type:'function', function:{ name:'update_contact', description:'Update a contact (next step/status/deadline/last contact) by row id from list_contacts', parameters:{ type:'object', properties:{ row:{type:'number'}, next_step:{type:'string'}, status:{type:'string'}, next_step_deadline:{type:'string'}, last_contact:{type:'string'} }, required:['row'] } } },
];

// ── Telegram helpers ──────────────────────────────────────────────────────────
function tgRequest(method, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(`${TG_BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendMessage(chatId, text) {
  const MAX = 4000;
  if (text.length <= MAX) {
    return tgRequest('sendMessage', { chat_id: chatId, text });
  }
  for (let i = 0; i < text.length; i += MAX) {
    await tgRequest('sendMessage', { chat_id: chatId, text: text.slice(i, i + MAX) });
  }
}

// ── MCP servers ───────────────────────────────────────────────────────────────
let taskServer, calendarServer, sheetsServer;
const taskPending = {}, calPending = {}, sheetsPending = {};

function startMCPServer(scriptPath, env, pendingMap, role) {
  const proc = spawn('node', [scriptPath], { env: { ...process.env, ...env }, stdio: ['pipe','pipe','pipe'] });
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', line => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingMap[msg.id]) {
        const { resolve, reject } = pendingMap[msg.id];
        delete pendingMap[msg.id];
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {}
  });
  proc.stderr.on('data', d => console.error(`[${role}]`, d.toString().trim()));
  proc.on('exit', code => {
    console.log(`[${role}] exited (${code}), restarting...`);
    setTimeout(() => {
      const next = startMCPServer(scriptPath, env, pendingMap, role);
      if (role === 'tasks') taskServer = next;
      else if (role === 'sheets') sheetsServer = next;
      else calendarServer = next;
    }, 3000);
  });
  proc.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:0, method:'initialize', params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{ name:'bot', version:'1' } } }) + '\n');
  return proc;
}

function callMCP(proc, pendingMap, toolName, args) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.random();
    pendingMap[id] = { resolve, reject };
    proc.stdin.write(JSON.stringify({ jsonrpc:'2.0', id, method:'tools/call', params:{ name:toolName, arguments:args } }) + '\n');
    setTimeout(() => { if (pendingMap[id]) { delete pendingMap[id]; reject(new Error('MCP timeout')); } }, 30000);
  });
}

// ── Dynamic timezone & cron management ────────────────────────────────────────────────
let cronMorning, cronEvening, cronHealth, cronMonthEnd;

function scheduleCrons() {
  const tz = cfg.timezone || 'America/Los_Angeles';
  if (cronMorning)  cronMorning.destroy();
  if (cronEvening)  cronEvening.destroy();
  if (cronHealth)   cronHealth.destroy();
  if (cronMonthEnd) cronMonthEnd.destroy();
  cronMorning  = cron.schedule('0 7 * * *',  () => sendBriefing('morning'),  { timezone: tz });
  cronEvening  = cron.schedule('0 20 * * *', () => sendBriefing('evening'),  { timezone: tz });
  cronHealth   = cron.schedule('0 2 * * *',  runHealthCheck,                 { timezone: tz });
  cronMonthEnd = cron.schedule('0 9 1 * *',  sendMonthlyUsageReport,         { timezone: tz });
  console.log(`[cron] scheduled for timezone: ${tz}`);
}

async function doUpdateTimezone({ timezone }) {
  if (!timezone) return 'Error: timezone string required';
  cfg.timezone = timezone;
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  scheduleCrons();
  console.log(`[timezone] updated to ${timezone}`);
  return `Timezone actualizado a ${timezone}. Briefs reprogramados.`;
}

async function checkCalendarTimezone() {
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.google_client_id, client_secret: cfg.google_client_secret,
        refresh_token: cfg.google_refresh_token, grant_type: 'refresh_token'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) { console.log('[tz-check] token refresh failed'); return; }
    const tzRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/settings/timezone', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const tzData = await tzRes.json();
    const calTz = tzData.value;
    if (!calTz) { console.log('[tz-check] no timezone in calendar response'); return; }
    if (calTz !== cfg.timezone) {
      console.log(`[tz-check] timezone changed: ${cfg.timezone} → ${calTz}`);
      await doUpdateTimezone({ timezone: calTz });
      if (cfg.telegram_chat_id) {
        await sendMessage(cfg.telegram_chat_id,
          `🌍 Detecté que tu timezone cambió a ${calTz} — adjusté los briefs.`);
      }
    } else {
      console.log(`[tz-check] timezone unchanged: ${calTz}`);
    }
  } catch (err) {
    console.log(`[tz-check] error: ${err.message}`);
  }
}

const TASK_TOOLS   = ['list_tasks','add_task','update_task','update_tasks','delete_task','get_usage','add_category'];
const CAL_TOOLS    = ['add_calendar_event','update_calendar_event','list_calendar_events','scan_gmail_for_actions','lookup_google_contact'];
const SHEETS_TOOLS = ['add_debt','list_debts','update_debt_status','add_contact','list_contacts','update_contact'];

async function callTool(name, args) {
  try {
    if (name === 'update_timezone') return await doUpdateTimezone(args);
    const proc = TASK_TOOLS.includes(name) ? taskServer
               : CAL_TOOLS.includes(name) ? calendarServer
               : SHEETS_TOOLS.includes(name) ? sheetsServer
               : null;
    const map  = TASK_TOOLS.includes(name) ? taskPending
               : SHEETS_TOOLS.includes(name) ? sheetsPending
               : calPending;
    if (!proc) return `Unknown tool: ${name}`;
    const result = await callMCP(proc, map, name, args);
    if (result?.content) return result.content.map(c => c.text || JSON.stringify(c)).join('\n');
    return JSON.stringify(result);
  } catch (err) { return `Tool error: ${err.message}`; }
}

// ── Conversation history ──────────────────────────────────────────────────────
const histories = {};
function getHistory(chatId) {
  if (!histories[chatId]) histories[chatId] = [];
  return histories[chatId];
}

// ── Main LLM handler ──────────────────────────────────────────────────────────
async function handleMessage(chatId, userText) {
  const history = getHistory(chatId);
  history.push({ role:'user', content:userText });
  if (history.length > 20) history.splice(0, history.length - 20);

  const now = new Date();
  const todayISO = now.toLocaleDateString('en-CA', { timeZone: cfg.timezone || 'America/Los_Angeles' }); // YYYY-MM-DD
  const todayReadable = now.toLocaleDateString('es-MX', { timeZone: cfg.timezone || 'America/Los_Angeles', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const systemWithDate = SYSTEM_PROMPT.replace('__CATEGORIES__', buildCategoriesSection()) + `\n\n== FECHA ACTUAL ==\nHoy es ${todayReadable} (${todayISO}). Usa esta fecha para calcular "hoy", "mañana", "el miércoles", "la próxima semana", etc. SIEMPRE usa año ${now.getFullYear()} en las fechas.`;
  const messages = [{ role:'system', content:systemWithDate }, ...history];
  const deadline = Date.now() + 55000;

  try {
    let response = await openai.chat.completions.create({ model:cfg.openai_model, messages, tools:TOOLS, tool_choice:'auto' });
    if (response.usage) logUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
    let msg = response.choices[0].message;
    messages.push(msg);

    while (msg.tool_calls?.length && Date.now() < deadline) {
      const results = await Promise.all(msg.tool_calls.map(async tc => {
        const args = JSON.parse(tc.function.arguments || '{}');
        console.log(`[tool] ${tc.function.name}`, JSON.stringify(args).slice(0,80));
        const result = await callTool(tc.function.name, args);
        return { tool_call_id:tc.id, role:'tool', content:result };
      }));
      messages.push(...results);

      if (Date.now() >= deadline) {
        await sendMessage(chatId, '⚠️ Tardé demasiado. Intenta de nuevo.');
        return;
      }

      response = await openai.chat.completions.create({ model:cfg.openai_model, messages, tools:TOOLS, tool_choice:'auto' });
      if (response.usage) logUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
      msg = response.choices[0].message;
      messages.push(msg);
    }

    const reply = msg.content || '(sin respuesta)';
    history.push({ role:'assistant', content:reply });
    await sendMessage(chatId, reply);
    console.log(`[reply → ${chatId}]`, reply.slice(0, 100));
  } catch (err) {
    console.error('[handleMessage error]', err.message);
    await sendMessage(chatId, '❌ Error interno. Intenta de nuevo.');
  }
}

// ── Cron briefings ────────────────────────────────────────────────────────────
async function sendMonthlyUsageReport() {
  const chatId = cfg.telegram_chat_id;
  if (!chatId) return;
  const prev = new Date();
  prev.setMonth(prev.getMonth() - 1);
  const month = prev.toISOString().slice(0, 7);
  await handleMessage(chatId, `Mándame el reporte de uso de OpenAI para el mes ${month}`);
}

async function sendBriefing(type) {
  const chatId = cfg.telegram_chat_id;
  if (!chatId) { console.log('[cron] no chat_id yet, skipping'); return; }
  const text = type === 'morning'
    ? 'Buenos días. Dame mi resumen matutino siguiendo el formato de FORMAT RULES: llama a list_calendar_events con days_ahead 1 (muestra solo eventos de HOY; si no hay, escribe exactamente "Sin eventos hoy"), list_tasks con filter overdue_and_today, scan_gmail_for_actions con account all y newer_than_days 2, list_debts con filter pending, y list_contacts con filter due. Muestra las secciones 📅 AGENDA HOY, 📬 EMAILS, ✅ TAREAS agrupadas por categoría, 💰 DEUDAS PENDIENTES y 🤝 NETWORKING (follow-ups). Omite 💰 y 🤝 si no hay contenido.'
    : 'Buenas noches. Llama a list_tasks con filter overdue_and_today y list_calendar_events con days_ahead 2 (muestra solo eventos de MAÑANA en la sección 📅 AGENDA DE MAÑANA; si no hay, escribe exactamente "Sin eventos mañana"). Usa el formato de FORMAT RULES: ✅ TAREAS agrupadas por categoría (cada categoría aparece una sola vez), luego 📅 AGENDA DE MAÑANA. Luego pregunta: ¿Qué tareas completaste hoy?';
  await handleMessage(chatId, text);
}

// morning/evening/health crons scheduled via scheduleCrons() in start()

// ── Nightly health check ───────────────────────────────────────────────────
async function runHealthCheck() {
  const results = [];

  // 1. Telegram API
  try {
    const r = await tgRequest('getMe', {});
    results.push(r.ok ? { ok: true, name: 'Telegram API' }
                       : { ok: false, name: 'Telegram API', detail: JSON.stringify(r) });
  } catch (e) { results.push({ ok: false, name: 'Telegram API', detail: e.message }); }

  // 2. Task API
  try {
    const r = await fetch(`${cfg.task_api_base}/api/tasks`, {
      headers: { Authorization: `Bearer ${cfg.task_api_secret}` }
    });
    results.push(r.ok ? { ok: true, name: 'Task API' }
                       : { ok: false, name: 'Task API', detail: `HTTP ${r.status}` });
  } catch (e) { results.push({ ok: false, name: 'Task API', detail: e.message }); }

  // 3 & 4. Google OAuth — attempt a token refresh for each account
  for (const [label, refreshToken] of [
    ['Google OAuth (personal)',  cfg.google_refresh_token],
    ['Google OAuth (Berkeley)',  cfg.google_refresh_token_berkeley],
  ]) {
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     cfg.google_client_id,
          client_secret: cfg.google_client_secret,
          refresh_token: refreshToken,
          grant_type:    'refresh_token',
        }),
      });
      const j = await r.json();
      results.push(j.access_token ? { ok: true, name: label }
                                   : { ok: false, name: label, detail: j.error || JSON.stringify(j) });
    } catch (e) { results.push({ ok: false, name: label, detail: e.message }); }
  }

  // 5. MCP processes still alive
  const mcpAlive = taskServer?.exitCode === null && calendarServer?.exitCode === null && sheetsServer?.exitCode === null;
  results.push(mcpAlive ? { ok: true, name: 'MCP servers' }
                        : { ok: false, name: 'MCP servers',
                            detail: `tasks exitCode=${taskServer?.exitCode} cal exitCode=${calendarServer?.exitCode} sheets exitCode=${sheetsServer?.exitCode}` });

  // 6. Task DB integrity — invalid statusFinalOutcome values
  // (values no filter recognizes → task silently disappears from all views)
  try {
    const r = await fetch(`${cfg.task_api_base}/api/tasks`, {
      headers: { Authorization: `Bearer ${cfg.task_api_secret}` }
    });
    if (r.ok) {
      const data = await r.json();
      const tasks = data.tasks || [];
      const VALID_STATUS = new Set(["done", "to-do", "on hold", ""]);
      const badStatus = tasks.filter(
        t => !VALID_STATUS.has((t.statusFinalOutcome || "").toLowerCase())
      );
      results.push(
        badStatus.length === 0
          ? { ok: true, name: 'Task DB — status integrity' }
          : { ok: false, name: 'Task DB — status integrity',
              detail: `${badStatus.length} task(s) with unknown status: ${badStatus.map(t => `#${t.rowId} "${t.statusFinalOutcome}"`).join(', ')}` }
      );

      // 7. Pending tasks with no due date (invisible to all date-based filters)
      const noDueDate = tasks.filter(
        t => (t.statusFinalOutcome || '').toLowerCase() === 'to-do' && !t.dueDateNextStep
      );
      results.push(
        noDueDate.length === 0
          ? { ok: true, name: 'Task DB — missing due dates' }
          : { ok: false, name: 'Task DB — missing due dates',
              detail: `${noDueDate.length} pending task(s) have no due date and won't appear in any filter: ${noDueDate.map(t => `#${t.rowId} "${(t.toDo || '').slice(0,30)}"`).join(', ')}` }
      );

      // 8. Orphan priority flags (priority.json references deleted task IDs)
      try {
        const priorityRaw = fs.readFileSync('/root/.openclaw/priority.json', 'utf8');
        const priority = JSON.parse(priorityRaw);
        const taskIds = new Set(tasks.map(t => String(t.rowId)));
        const orphans = Object.keys(priority).filter(id => priority[id] && !taskIds.has(id));
        results.push(
          orphans.length === 0
            ? { ok: true, name: 'Task DB — priority flags' }
            : { ok: false, name: 'Task DB — priority flags',
                detail: `${orphans.length} orphan priority flag(s) for deleted tasks: IDs ${orphans.join(', ')}` }
        );
      } catch (e) { results.push({ ok: true, name: 'Task DB — priority flags' }); }

    } else {
      results.push({ ok: false, name: 'Task DB — status integrity', detail: `HTTP ${r.status}` });
      results.push({ ok: false, name: 'Task DB — missing due dates', detail: `HTTP ${r.status}` });
      results.push({ ok: false, name: 'Task DB — priority flags', detail: `HTTP ${r.status}` });
    }
  } catch (e) {
    results.push({ ok: false, name: 'Task DB — integrity checks', detail: e.message });
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) {
    console.log('[health] all checks passed');
    return;
  }

  // Send alert only if something failed
  const now = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' });
  const lines = results.map(r => `${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const msg = `⚠️ Health check — ${now}\n` + lines.join('\n');
  await sendMessage(cfg.telegram_chat_id, msg);
  console.log(`[health] ${failed.length} check(s) failed — alert sent`);
}

// health check cron scheduled via scheduleCrons()

// ── Voice transcription ───────────────────────────────────────────────────────
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, res => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

async function transcribeVoice(fileId) {
  // Step 1: get file path from Telegram
  const fileInfo = await tgRequest('getFile', { file_id: fileId });
  if (!fileInfo.ok) throw new Error('getFile failed: ' + JSON.stringify(fileInfo));
  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${cfg.telegram_token}/${filePath}`;

  // Step 2: download to temp file
  const tmpPath = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
  await downloadFile(fileUrl, tmpPath);

  // Step 3: transcribe with Whisper
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'es',
    });
    return transcription.text;
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// ── Long polling loop ─────────────────────────────────────────────────────────
let offset = 0;
const processing = new Set(); // deduplicate concurrent messages
const chatQueues = new Map(); // per-chat FIFO queue — sequential processing per user

async function poll() {
  try {
    const res = await tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    if (!res.ok || !res.result?.length) return;

    for (const update of res.result) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!message) continue;

      const chatId = message.chat.id;
      const fromName = message.from?.first_name || 'user';
      let text = message.text || '';

      // Handle voice messages — transcribe with Whisper
      const voiceFileId = message.voice?.file_id || message.audio?.file_id;
      if (voiceFileId && !text) {
        try {
          console.log(`[voice] transcribing from ${fromName}...`);
          text = await transcribeVoice(voiceFileId);
          console.log(`[voice→text] ${text.slice(0, 100)}`);
        } catch (err) {
          console.error('[voice error]', err.message);
          if (chatId === cfg.telegram_chat_id) {
            await sendMessage(chatId, '❌ No pude transcribir el audio. Intenta de nuevo.');
          }
          continue;
        }
      }

      if (!text?.trim()) continue;

      // Save chat_id on first contact
      if (!cfg.telegram_chat_id) {
        cfg.telegram_chat_id = chatId;
        fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
        console.log(`[setup] Saved chat_id: ${chatId} (${fromName})`);
      }

      // Only respond to authorized user
      if (chatId !== cfg.telegram_chat_id) {
        console.log(`[ignored] unknown user: ${chatId}`);
        continue;
      }

      // Deduplicate
      const key = `${chatId}:${message.message_id}`;
      if (processing.has(key)) continue;
      processing.add(key);

      console.log(`[in] ${fromName}: ${text.slice(0,100)}`);
      // Queue ensures messages from same chat process one at a time (FIFO)
      const _prev = chatQueues.get(chatId) || Promise.resolve();
      const _curr = _prev.then(
        () => handleMessage(chatId, text).catch(() => {}),
        () => handleMessage(chatId, text).catch(() => {})
      );
      chatQueues.set(chatId, _curr);
      _curr.finally(() => {
        processing.delete(key);
        if (chatQueues.get(chatId) === _curr) chatQueues.delete(chatId);
      });
    }
  } catch (err) {
    console.error('[poll error]', err.message);
  }
}

// Run poll loop continuously
async function pollLoop() {
  while (true) {
    await poll();
    // No sleep needed — getUpdates with timeout=30 does long-polling itself
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  taskServer = startMCPServer('/root/.openclaw/skills/tasks-mcp.js',
    { TASK_API_BASE: cfg.task_api_base, TASK_API_SECRET: cfg.task_api_secret },
    taskPending, 'tasks');
  calendarServer = startMCPServer('/root/.openclaw/skills/calendar-mcp.js',
    { GOOGLE_CLIENT_ID: cfg.google_client_id, GOOGLE_CLIENT_SECRET: cfg.google_client_secret,
      GOOGLE_REFRESH_TOKEN: cfg.google_refresh_token, GOOGLE_REFRESH_TOKEN_BERKELEY: cfg.google_refresh_token_berkeley,
      TIMEZONE: cfg.timezone || 'America/Los_Angeles' },
    calPending, 'calendar');
  sheetsServer = startMCPServer('/root/.openclaw/skills/sheets-mcp.js',
    { GOOGLE_CLIENT_ID: cfg.google_client_id, GOOGLE_CLIENT_SECRET: cfg.google_client_secret,
      GOOGLE_REFRESH_TOKEN_BERKELEY: cfg.google_refresh_token_berkeley,
      FINANCE_SHEET_ID: cfg.finance_sheet_id, NETWORK_SHEET_ID: cfg.network_sheet_id,
      TIMEZONE: cfg.timezone || 'America/Los_Angeles' },
    sheetsPending, 'sheets');

  console.log('✅ Bot started — polling Telegram (no webhook needed)');
  console.log('   Send any message to @Melizion_bot on Telegram');

  scheduleCrons();
  // timezone auto-detect disabled (Calendar API returns stale value)
  // use update_timezone tool or tell Melissa you are in a different city

  pollLoop(); // fire and forget — runs forever
}

start().catch(err => { console.error('Fatal:', err); process.exit(1); });
