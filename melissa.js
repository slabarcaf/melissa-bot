require('dotenv').config();

const OpenAI = require('openai');
const cron = require('node-cron');
const { spawn } = require('child_process');
const readline = require('readline');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Load config: prefer .env vars, fall back to config.json (production)
function loadConfig() {
  if (process.env.TELEGRAM_TOKEN) {
    return {
      openai_api_key:                process.env.OPENAI_API_KEY,
      openai_model:                  process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      telegram_token:                process.env.TELEGRAM_TOKEN,
      telegram_chat_id:              process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null,
      task_api_base:                 process.env.TASK_API_BASE,
      task_api_secret:               process.env.TASK_API_SECRET,
      google_client_id:              process.env.GOOGLE_CLIENT_ID,
      google_client_secret:          process.env.GOOGLE_CLIENT_SECRET,
      google_refresh_token:          process.env.GOOGLE_REFRESH_TOKEN,
      google_refresh_token_berkeley: process.env.GOOGLE_REFRESH_TOKEN_BERKELEY,
      webhook_port:                  Number(process.env.WEBHOOK_PORT || 3000),
    };
  }
  const cfgPath = process.env.CFG_PATH || '/root/whatsapp-bot/config.json';
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

let cfg = loadConfig();

const TASKS_MCP_PATH    = process.env.TASKS_MCP_PATH    || '/root/.openclaw/skills/tasks-mcp.js';
const CALENDAR_MCP_PATH = process.env.CALENDAR_MCP_PATH || '/root/.openclaw/skills/calendar-mcp.js';

const openai = new OpenAI({ apiKey: cfg.openai_api_key });
const TG_BASE = `https://api.telegram.org/bot${cfg.telegram_token}`;

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Melissa, Santiago's personal assistant. You have an easy-going, young energy — you keep things light and aren't afraid to drop a quick joke or a playful comment when the moment feels right. But you're also sharp and assertive: when something needs to get done, you're direct and don't waste words. And when it comes to process — task IDs, update rules, how things must be done — you're strict, no exceptions. Be concise. Reply in the user's language.

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

Tasks must be grouped by category. Each category header appears exactly once — merge all tasks of the same category under one header regardless of due date. If a category has no tasks, omit it. Never output a paragraph of tasks separated by commas or semicolons.
🔴 appears ONLY on tasks that have 🔴 in the tool output — do NOT add 🔴 to tasks that don't have it.
Calendar empty-state: for 📅 AGENDA HOY say "Sin eventos hoy" if no events. For 📅 AGENDA DE MAÑANA say "Sin eventos mañana" if no events. Never say "próximos N días".

== TASK LISTS ==
ALWAYS call list_tasks immediately when the user mentions tasks — NEVER ask clarifying questions, NEVER summarize, NEVER say there are no tasks without calling the tool first.
Default filter: "overdue_and_today". Use "overdue_and_today" for morning briefs and any general task request. Use "overdue" when user asks for past-due tasks only. Use "this_week" for weekly view.
Triggers: tareas, tasks, qué tengo, lista, muéstrame, enviar tareas, mis tareas, pendientes, show tasks, dame mis tareas → call list_tasks NOW.
After the tool returns: each line contains [#N] — keep those IDs in memory for update_task/delete_task, but NEVER show [#N] in your reply to the user. This rule applies to all task displays including cron briefings.
Format each task like this:
  🔴 Nombre de tarea — Lun 5 may   ← tarea importante (🔴 ya viene en el output)
  - Nombre de tarea — Lun 5 may    ← tarea normal
Rules: always show the date from the tool output | keep 🔴 for priority tasks | preserve sort order (most overdue first, today's tasks after) | do NOT skip tasks | do NOT say "tienes X tareas".
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
  qué tengo en el calendario → list_calendar_events, relay verbatim.

== CATEGORIES ==
Ayudantias | Clases | Finanzas | Golf club | Otros | Recruiting | S3 | University
golf/club/tee → Golf club | pagar/banco/zelle/tarjeta → Finanzas | clase/tarea/prueba/examen → Clases
ayudantía/ayudante → Ayudantias | postular/entrevista/cv → Recruiting | S3/startup → S3
berkeley/GSB/campus → University | default → Otros

When calling add_task (ONLY — never apply this to calendar events):
1. Infer the best category from the task description using the keywords above.
2. Say: "Esto parece [Category]. ¿Lo agrego ahí? ¿Y para cuándo vence?"
3. If both category and due date are missing, ask them together in one message.
4. Wait for the user's confirmation, then call add_task with the confirmed values.
Never silently assign "Otros" without proposing — always confirm with the user first.
NEVER ask for category when adding a calendar event — category applies to tasks only.`;

// ── OpenAI tools ──────────────────────────────────────────────────────────────
const TOOLS = [
  { type:'function', function:{ name:'list_tasks', description:'List tasks with optional filter', parameters:{ type:'object', properties:{ filter:{ type:'string', enum:['all','pending','today','tomorrow','this_week','overdue','overdue_and_today','on_hold'] }, section:{ type:'string' } } } } },
  { type:'function', function:{ name:'add_task', description:'Add a new task', parameters:{ type:'object', properties:{ toDo:{type:'string'}, dueDateNextStep:{type:'string'}, tipo:{type:'string'}, nextStep:{type:'string'}, isPriority:{type:'boolean'}, recurrenceInterval:{type:'number'}, recurrenceUnit:{type:'string'} }, required:['toDo'] } } },
  { type:'function', function:{ name:'update_task', description:'Update a single task by taskId', parameters:{ type:'object', properties:{ taskId:{type:'number'}, toDo:{type:'string'}, statusFinalOutcome:{type:'string'}, dueDateNextStep:{type:'string'}, tipo:{type:'string'}, nextStep:{type:'string'}, isPriority:{type:'boolean'} }, required:['taskId'] } } },
  { type:'function', function:{ name:'update_tasks', description:'Batch update multiple tasks at once', parameters:{ type:'object', properties:{ updates:{ type:'array', items:{ type:'object', properties:{ taskId:{type:'number'}, toDo:{type:'string'}, statusFinalOutcome:{type:'string'}, dueDateNextStep:{type:'string'}, isPriority:{type:'boolean'} }, required:['taskId'] } } }, required:['updates'] } } },
  { type:'function', function:{ name:'delete_task', description:'Delete a task by taskId', parameters:{ type:'object', properties:{ taskId:{type:'number'} }, required:['taskId'] } } },
  { type:'function', function:{ name:'get_usage', description:'Get estimated token usage this month', parameters:{ type:'object', properties:{} } } },
  { type:'function', function:{ name:'add_calendar_event', description:'Add event to Berkeley calendar', parameters:{ type:'object', properties:{ title:{type:'string'}, date:{type:'string'}, time:{type:'string'}, duration_minutes:{type:'number'}, description:{type:'string'} }, required:['title','date','time'] } } },
  { type:'function', function:{ name:'list_calendar_events', description:'List upcoming calendar events', parameters:{ type:'object', properties:{ days_ahead:{type:'number'} } } } },
  { type:'function', function:{ name:'scan_gmail_for_actions', description:'Scan Gmail for actionable emails', parameters:{ type:'object', properties:{ account:{type:'string', enum:['personal','berkeley','all']}, max_emails:{type:'number'}, newer_than_days:{type:'number'} } } } },
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
let taskServer, calendarServer;
const taskPending = {}, calPending = {};

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

const TASK_TOOLS = ['list_tasks','add_task','update_task','update_tasks','delete_task','get_usage'];
const CAL_TOOLS  = ['add_calendar_event','list_calendar_events','scan_gmail_for_actions'];

async function callTool(name, args) {
  try {
    const proc = TASK_TOOLS.includes(name) ? taskServer : CAL_TOOLS.includes(name) ? calendarServer : null;
    const map  = TASK_TOOLS.includes(name) ? taskPending : calPending;
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
  const todayISO = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const todayReadable = now.toLocaleDateString('es-MX', { timeZone: 'America/Los_Angeles', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const systemWithDate = SYSTEM_PROMPT + `\n\n== FECHA ACTUAL ==\nHoy es ${todayReadable} (${todayISO}). Usa esta fecha para calcular "hoy", "mañana", "el miércoles", "la próxima semana", etc. SIEMPRE usa año ${now.getFullYear()} en las fechas.`;
  const messages = [{ role:'system', content:systemWithDate }, ...history];
  const deadline = Date.now() + 55000;

  try {
    let response = await openai.chat.completions.create({ model:cfg.openai_model, messages, tools:TOOLS, tool_choice:'auto' });
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
async function sendBriefing(type) {
  const chatId = cfg.telegram_chat_id;
  if (!chatId) { console.log('[cron] no chat_id yet, skipping'); return; }
  const text = type === 'morning'
    ? 'Buenos días. Dame mi resumen matutino siguiendo el formato de FORMAT RULES: llama a list_calendar_events con days_ahead 1 (muestra solo eventos de HOY; si no hay, escribe exactamente "Sin eventos hoy"), list_tasks con filter overdue_and_today, y scan_gmail_for_actions con account all y newer_than_days 2. Muestra las secciones 📅 AGENDA HOY, 📬 EMAILS y ✅ TAREAS agrupadas por categoría.'
    : 'Buenas noches. Llama a list_tasks con filter overdue_and_today y list_calendar_events con days_ahead 2 (muestra solo eventos de MAÑANA en la sección 📅 AGENDA DE MAÑANA; si no hay, escribe exactamente "Sin eventos mañana"). Usa el formato de FORMAT RULES: ✅ TAREAS agrupadas por categoría (cada categoría aparece una sola vez), luego 📅 AGENDA DE MAÑANA. Luego pregunta: ¿Qué tareas completaste hoy?';
  await handleMessage(chatId, text);
}

cron.schedule('0 7 * * *',  () => sendBriefing('morning'), { timezone:'America/Los_Angeles' });
cron.schedule('0 20 * * *', () => sendBriefing('evening'), { timezone:'America/Los_Angeles' });

// ── Nightly health check ───────────────────────────────────────────────────
async function runHealthCheck() {
  const results = [];

  try {
    const r = await tgRequest('getMe', {});
    results.push(r.ok ? { ok: true, name: 'Telegram API' }
                       : { ok: false, name: 'Telegram API', detail: JSON.stringify(r) });
  } catch (e) { results.push({ ok: false, name: 'Telegram API', detail: e.message }); }

  try {
    const r = await fetch(`${cfg.task_api_base}/api/tasks`, {
      headers: { Authorization: `Bearer ${cfg.task_api_secret}` }
    });
    results.push(r.ok ? { ok: true, name: 'Task API' }
                       : { ok: false, name: 'Task API', detail: `HTTP ${r.status}` });
  } catch (e) { results.push({ ok: false, name: 'Task API', detail: e.message }); }

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

  const mcpAlive = taskServer?.exitCode === null && calendarServer?.exitCode === null;
  results.push(mcpAlive ? { ok: true, name: 'MCP servers' }
                        : { ok: false, name: 'MCP servers',
                            detail: `tasks exitCode=${taskServer?.exitCode} cal exitCode=${calendarServer?.exitCode}` });

  try {
    const r = await fetch(`${cfg.task_api_base}/api/tasks`, {
      headers: { Authorization: `Bearer ${cfg.task_api_secret}` }
    });
    if (r.ok) {
      const data = await r.json();
      const tasks = data.tasks || [];
      const VALID_STATUS = new Set(["done", "to-do", "on hold", ""]);
      const badStatus = tasks.filter(t => !VALID_STATUS.has((t.statusFinalOutcome || "").toLowerCase()));
      results.push(
        badStatus.length === 0
          ? { ok: true, name: 'Task DB — status integrity' }
          : { ok: false, name: 'Task DB — status integrity',
              detail: `${badStatus.length} task(s) with unknown status: ${badStatus.map(t => `#${t.rowId} "${t.statusFinalOutcome}"`).join(', ')}` }
      );

      const noDueDate = tasks.filter(t => (t.statusFinalOutcome || '').toLowerCase() === 'to-do' && !t.dueDateNextStep);
      results.push(
        noDueDate.length === 0
          ? { ok: true, name: 'Task DB — missing due dates' }
          : { ok: false, name: 'Task DB — missing due dates',
              detail: `${noDueDate.length} pending task(s) have no due date: ${noDueDate.map(t => `#${t.rowId} "${(t.toDo || '').slice(0,30)}"`).join(', ')}` }
      );
    } else {
      results.push({ ok: false, name: 'Task DB — integrity checks', detail: `HTTP ${r.status}` });
    }
  } catch (e) {
    results.push({ ok: false, name: 'Task DB — integrity checks', detail: e.message });
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) { console.log('[health] all checks passed'); return; }

  const now = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' });
  const lines = results.map(r => `${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  await sendMessage(cfg.telegram_chat_id, `⚠️ Health check — ${now}\n` + lines.join('\n'));
  console.log(`[health] ${failed.length} check(s) failed — alert sent`);
}

cron.schedule('0 2 * * *', runHealthCheck, { timezone: 'America/Los_Angeles' });

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
  const fileInfo = await tgRequest('getFile', { file_id: fileId });
  if (!fileInfo.ok) throw new Error('getFile failed: ' + JSON.stringify(fileInfo));
  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${cfg.telegram_token}/${filePath}`;

  const tmpPath = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
  await downloadFile(fileUrl, tmpPath);

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
const processing = new Set();

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

      if (!cfg.telegram_chat_id) {
        cfg.telegram_chat_id = chatId;
        fs.writeFileSync(process.env.CFG_PATH || '/root/whatsapp-bot/config.json', JSON.stringify(cfg, null, 2));
        console.log(`[setup] Saved chat_id: ${chatId} (${fromName})`);
      }

      if (chatId !== cfg.telegram_chat_id) {
        console.log(`[ignored] unknown user: ${chatId}`);
        continue;
      }

      const key = `${chatId}:${message.message_id}`;
      if (processing.has(key)) continue;
      processing.add(key);

      console.log(`[in] ${fromName}: ${text.slice(0,100)}`);
      handleMessage(chatId, text).finally(() => processing.delete(key));
    }
  } catch (err) {
    console.error('[poll error]', err.message);
  }
}

async function pollLoop() {
  while (true) {
    await poll();
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  taskServer = startMCPServer(TASKS_MCP_PATH,
    { TASK_API_BASE: cfg.task_api_base, TASK_API_SECRET: cfg.task_api_secret },
    taskPending, 'tasks');
  calendarServer = startMCPServer(CALENDAR_MCP_PATH,
    { GOOGLE_CLIENT_ID: cfg.google_client_id, GOOGLE_CLIENT_SECRET: cfg.google_client_secret,
      GOOGLE_REFRESH_TOKEN: cfg.google_refresh_token, GOOGLE_REFRESH_TOKEN_BERKELEY: cfg.google_refresh_token_berkeley,
      TIMEZONE: 'America/Los_Angeles' },
    calPending, 'calendar');

  console.log('✅ Melissa started — polling Telegram');
  console.log('   Send any message to @Melizion_bot on Telegram');

  pollLoop();
}

start().catch(err => { console.error('Fatal:', err); process.exit(1); });
