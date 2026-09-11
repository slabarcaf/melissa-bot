const OpenAI = require('openai');
const cron = require('node-cron');
const { spawn } = require('child_process');
const readline = require('readline');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const prefs = require('./prefs');

const CFG_PATH = process.env.CFG_PATH || '/root/whatsapp-bot/config.json';
const CATS_PATH = process.env.CATS_PATH || '/root/whatsapp-bot/categories.json';
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

function buildCategoriesSectionForUser(user) {
  let cats;
  try { cats = JSON.parse(user.categories || '[]'); } catch { cats = []; }
  // Falls back to the shared file rather than a three-item stub. That file is a
  // safety net now, not a source of truth: it is what this prompt uses only when
  // the mirror is empty — a brand-new user, or a sync that has not run yet.
  if (!cats.length) { try { cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8')); } catch { cats = []; } }
  if (!cats.length) cats = [{ name: 'Work', keywords: ['trabajo','reunión','meeting'] }, { name: 'Personal', keywords: ['personal','casa'] }, { name: 'Otros', keywords: [] }];
  const names = cats.map(c => c.name).join(' | ');
  const kws   = cats.filter(c => c.keywords && c.keywords.length > 0)
    .map(c => `${c.keywords.join('/')} → ${c.name}`).join(' | ');
  return `== CATEGORIES ==\n${names}\n${kws} | default → Otros`;
}

const USAGE_LOG = process.env.USAGE_LOG || '/root/.openclaw/usage/usage-log.jsonl';
function logUsage(inputTok, outputTok) {
  const entry = { ts: new Date().toISOString(), tool: 'llm', input: inputTok, output: outputTok };
  try { fs.appendFileSync(USAGE_LOG, JSON.stringify(entry) + '\n'); } catch {}
}
let cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const openai = new OpenAI({ apiKey: cfg.openai_api_key });

const TG_BASE = `https://api.telegram.org/bot${cfg.telegram_token}`;

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Sydney, Santiago's personal assistant. You have an easy-going, young energy — you keep things light and aren't afraid to drop a quick joke or a playful comment when the moment feels right. But you're also sharp and assertive: when something needs to get done, you're direct and don't waste words. And when it comes to process — task IDs, update rules, how things must be done — you're strict, no exceptions. Be concise. __LANGUAGE__

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
(si no hay emails accionables tras el filtro, bajo 📬 *EMAILS* escribe exactamente: "Sin emails con acción pendiente en los últimos 2 días." — nunca dejes la sección vacía ni repitas instrucciones de formato)

✅ *TAREAS*
*[Category]*
• 🔴 [priority task — only if 🔴 appears in tool output] ([date])
• [regular task — no emoji] ([date])
• 🔜 [task due TOMORROW — only if 🔜 appears in tool output] ([date])

*[Next Category]*
• [task] ([date])

💰 *DEUDAS PENDIENTES*
• [nombre] — [monto] [moneda] — [Me deben/Debo yo]

🤝 *NETWORKING (follow-ups)*
• [nombre] — [próximo paso] — vence [fecha]

The 💰 DEUDAS PENDIENTES and 🤝 NETWORKING sections appear ONLY in briefings when their tools were called and returned content — omit each if empty. Never invent debts or contacts.

Tasks must be grouped by category. Each task line from the tool starts with [Category] — use this tag to determine the category header, then strip it from the displayed task text. Each category header appears exactly once — merge ALL tasks of the same category under one header regardless of due date or section. The tool may return tasks split into ⏰ Vencidas, 📅 Para hoy and 🔜 Mañana sub-sections — ignore those dividers entirely when grouping for display: treat the full task list as one flat pool and group ONLY by [Category]. If a category has no tasks, omit it. Never output a paragraph of tasks separated by commas or semicolons.
🔴 appears ONLY on tasks that literally have "🔴 " at the start of the task line in the tool output — do NOT add 🔴 to tasks that don't have it, even if they are overdue.
🔜 marks a task due TOMORROW — it comes from the tool output; NEVER add 🔜 yourself. Keep 🔜 tasks under their normal [Category] alongside the due tasks, preserving the 🔜 at the start of the line (after 🔴 if the task also has it). Within each category, list overdue/today tasks first, then the 🔜 tomorrow tasks. (Only the evening brief's overdue_today_tomorrow filter returns 🔜 tasks.)
Calendar empty-state: for 📅 AGENDA HOY say "Sin eventos hoy" if no events. For 📅 AGENDA DE MAÑANA say "Sin eventos mañana" if no events. Never say "próximos N días".
DATE DISPLAY — whenever you show a task due date (task lists, briefs, confirmations, reminders), format it as day-month abbreviated with a dash: "8-Jul", "15-Ene" (month abbreviation in the user's language). Add the year ONLY when it is not the current year (e.g. "15-Ene-2027"). Never show ambiguous numeric dates like 8/7 or 07/08.

== TASK LISTS ==
ALWAYS call list_tasks immediately when the user mentions tasks — NEVER ask clarifying questions, NEVER summarize, NEVER say there are no tasks without calling the tool first.
Default filter: "overdue_and_today". Use "overdue_and_today" for morning briefs and any general task request. Use "overdue" when user asks for past-due tasks only. Use "this_week" for weekly view.
Triggers: tareas, tasks, qué tengo, lista, muéstrame, enviar tareas, mis tareas, pendientes, show tasks, dame mis tareas → call list_tasks NOW.
After the tool returns: each line contains [#N] — keep those IDs in memory for update_task/delete_task, but NEVER show [#N] in your reply to the user. This rule applies to all task displays including cron briefings.
Format each task like this:
  • 🔴 Nombre de tarea (5-May)   ← tarea importante (🔴 ya viene en el output)
  • Nombre de tarea (5-May)      ← tarea normal
The due date always goes in parentheses at the end of the line. Never use a dash before the date.
Rules: always show the date from the tool output | 🔴 ONLY if it literally appears at the start of the task line in the tool output — overdue tasks are NOT priority by default, NEVER add 🔴 yourself | preserve sort order (most overdue first, today's tasks after) | do NOT skip tasks | do NOT say "tienes X tareas".
NEVER use list position as taskId — always use the [#N] number from the tool output.

== CRITICAL — NEVER HALLUCINATE TASK ACTIONS (mark done / move / delete / update) ==
- NEVER say you marked, moved, updated, deleted, or completed a task unless you ACTUALLY called the matching tool (update_task / update_tasks / delete_task) in THIS SAME response turn. Phrasing intent as future tense — "voy a moverla", "la muevo", "la elimino", "I'll move it", "ya quedó" — is FORBIDDEN unless the tool call is emitted in this same turn. Do NOT describe an action as something you will do; perform it NOW by emitting the tool call, then report the verified result. If you cannot do it, say so plainly — never pretend it happened.
- NEVER say a task "was already marked as done" or "estaba ya marcada como lista" based only on conversation history. ALWAYS call list_tasks first to verify current status.
- If list_tasks returns a task in its output, that task IS PENDING in the database right now — always trust the tool result over anything said in previous messages.
- When user says to mark tasks done: ALWAYS call list_tasks FIRST to get fresh task data, match tasks by name to their [#N] IDs, THEN call update_tasks with those IDs. NEVER skip the list_tasks step.
- NEVER use any number the user provides (position numbers like '3.', '16.', etc.) as a taskId. Always look up the [#N] from a fresh list_tasks call.
- When marking tasks done, ALWAYS use statusFinalOutcome: "Done" (capital D, English). This applies regardless of how the user phrases it — "listo", "ya está", "hecho", "done", "realizado", "tachalo", "marcalo", "ya lo hice", "está listo" — ALL mean Done. Reason about user intent and always map to the exact string "Done".
- After EVERY mutation — update_task, update_tasks, AND delete_task — immediately call list_tasks and confirm the change is actually reflected: the task moved to its new category, or is gone after a delete, or shows the new status. If the task still appears unchanged, the operation FAILED — tell the user it failed and retry or ask; NEVER report success without this verification. For a delete, confirm the task no longer appears before saying it was deleted. For a move, confirm it now appears under the new [Category] before saying you moved it.

== RULES ==
- "Envíame/mándame/pásame X" (tareas, resumen, deudas) significa MOSTRARLO AQUÍ en el chat — nunca es un email. Solo usa send_email cuando el usuario pida explícitamente un correo a un destinatario.
- Si el usuario pide "el resumen / mi brief / mi resumen" a cualquier hora, trátalo como una petición normal: llama las mismas tools del brief y muestra las secciones de FORMAT RULES que le apliquen.
- Si el usuario pide algo que no puedes hacer, dilo con naturalidad y en una frase, di qué SÍ puedes hacer, y ofrece la alternativa más cercana. Nunca respondas con frases robóticas tipo "función no disponible".
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
NEXT STEP FIELD — only pass nextStep when the user EXPLICITLY states a concrete follow-up action ("llamar antes del viernes", "mandar el borrador primero"). Otherwise omit it: an empty nextStep is the correct default. NEVER use nextStep to park leftover, garbled or unparsed words from the user's message, never restate the task in it, and never put due-date wording in it — a phrase like "con vencimiento mañana" / "convencimiento mañana" is a DUE DATE, so it sets dueDateNextStep and nothing else. Voice messages are transcribed automatically and often join or split words; when a fragment looks like transcription noise, drop it rather than storing it.
When confirming a created or updated task, show only the task name, the category and the due date. NEVER echo nextStep back to the user.
NEVER ask for category when adding a calendar event — category applies to tasks only.
CATEGORY INTEGRITY — the tipo you pass to add_task or update_task MUST be an EXISTING category from the list above, matched EXACTLY including accents and casing ("Otros" not "Others", "Golf club" not "golf club"). NEVER invent a new category name through add_task/update_task — that silently creates duplicates. If a task doesn't fit any existing category, propose the closest existing one and confirm with the user.
To add a NEW category: ONLY when the user EXPLICITLY asks ("agrega la categoría X" / "crea una categoría para Y"). NEVER create a category on your own initiative. Before calling add_category: check the existing list — if the same or a similar category already exists (e.g. the user asks for "Others" but "Otros" exists, or "golf" but "Golf club" exists), DO NOT create it; tell the user it already exists and ask if that is the one they meant. Only if it is genuinely new: infer 3-5 keywords silently, then ASK for explicit confirmation first — "Voy a crear la categoría nueva [name] — ¿la creo?" — and WAIT for a yes before calling add_category. After creating, confirm: "✅ Categoría [name] creada. Ya disponible en la próxima conversación."

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

If Santiago says he is traveling or changing city/country → call update_timezone with the matching timezone string. Act immediately, no confirmation needed. Confirm what timezone was set and that briefs were rescheduled.

== BRIEFS ==
Los briefs de la mañana/noche se envían automáticamente a las horas que el usuario configuró.
Si el usuario pide cambiarlos de hora, quitar uno o desactivarlos ("mándame el brief a las 8", "ya no quiero el de la noche", "stop the morning brief") → llama update_brief_times(morning, evening) con formato HH:MM 24h; string vacío "" desactiva ese brief. Solo pasa el campo que cambia.
Recuérdale al usuario cuando venga al caso que puede escribirte a cualquier hora — los briefs son solo resúmenes programados.

== ADMIN (solo Santiago) ==
La gestión de usuarios es por comandos directos de Telegram, NO por tools: /users (lista usuarios), /invite <Nombre> [email] (invita), /resetuser <id> (repite el onboarding conservando datos), /deleteuser <id> confirm (elimina cuenta y deudas). Si Santiago pide ver, invitar, resetear o eliminar usuarios, respóndele con el comando exacto a enviar — NO inventes tools ni digas que lo hiciste tú.`;

// ── Multi-user helpers ────────────────────────────────────────────────────────

let botUsername = null;
async function fetchBotInfo() {
  const res = await tgRequest('getMe', {});
  if (res.ok) botUsername = res.result.username;
}

const PRESET_CATEGORIES = [
  { name: 'Work',          keywords: ['trabajo','work','office','meeting','reunión'] },
  { name: 'Estudios',      keywords: ['clase','tarea','prueba','examen','estudio'] },
  { name: 'Salud',         keywords: ['médico','doctor','gym','ejercicio','salud'] },
  { name: 'Personal',      keywords: ['personal','casa','familia'] },
  { name: 'Side Projects', keywords: ['proyecto','startup','side'] },
  { name: 'Finanzas',      keywords: ['pagar','banco','zelle','tarjeta','dinero'] },
  { name: 'Networking',    keywords: ['networking','contacto','conocí'] },
  { name: 'Otros',         keywords: [] },
];

// City/country → IANA zone. Returns { tz, matched } — matched:false means we're
// guessing (Americas default) and onboarding should ask the user to confirm.
// Order matters: country names ending in "la" (Venezuela, Guatemala) must be
// tested before the generic \bla\b → Los Angeles rule.
const CITY_TZ_TABLE = [
  [/santiago|chile/,                                        'America/Santiago'],
  [/bolivia|la paz/,                                        'America/La_Paz'],
  [/venezuela|caracas/,                                     'America/Caracas'],
  [/guatemala/,                                             'America/Guatemala'],
  [/bogot|colombia|medell|barranquilla/,                    'America/Bogota'],
  [/lima|per[uú]\b/,                                        'America/Lima'],
  [/quito|guayaquil|ecuador/,                               'America/Guayaquil'],
  [/montevideo|uruguay/,                                    'America/Montevideo'],
  [/asunci|paraguay/,                                       'America/Asuncion'],
  [/buenos aires|argentina|c[oó]rdoba|mendoza/,             'America/Argentina/Buenos_Aires'],
  [/s[aã]o paulo|sao paulo|brasil|brazil|rio de janeiro/,   'America/Sao_Paulo'],
  [/panam/,                                                 'America/Panama'],
  [/costa rica/,                                            'America/Costa_Rica'],
  [/honduras|tegucigalpa/,                                  'America/Tegucigalpa'],
  [/el salvador/,                                           'America/El_Salvador'],
  [/nicaragua|managua/,                                     'America/Managua'],
  [/m[eé]xico|mexico|cdmx|guadalajara|monterrey/,           'America/Mexico_City'],
  [/miami|florida|orlando|tampa/,                           'America/New_York'],
  [/new york|nyc|\bny\b|east coast|boston|washington|philadelphia|atlanta|toronto|montreal/, 'America/New_York'],
  [/chicago|illinois|houston|dallas|austin|texas/,          'America/Chicago'],
  [/denver|colorado|salt lake/,                             'America/Denver'],
  [/phoenix|arizona/,                                       'America/Phoenix'],
  [/madrid|barcelona|spain|espa[ñn]a/,                      'Europe/Madrid'],
  [/london|londres|\buk\b|england/,                         'Europe/London'],
  [/\bsf\b|san francisco|los angeles|california|berkeley|oakland|san diego|seattle|portland|\bla\b/, 'America/Los_Angeles'],
];

function parseCityToTimezone(text) {
  const t = (text || '').toLowerCase();
  for (const [re, tz] of CITY_TZ_TABLE) if (re.test(t)) return { tz, matched: true };
  if (/^[A-Za-z]+\/[A-Za-z_\/]+$/.test((text || '').trim())) return { tz: text.trim(), matched: true };
  return { tz: 'America/Los_Angeles', matched: false };
}

function parseCategorySelection(text) {
  const nums = [...text.matchAll(/\d+/g)].map(m => parseInt(m[0]) - 1);
  if (nums.length > 0) {
    const selected = nums.map(i => PRESET_CATEGORIES[i]).filter(Boolean);
    if (selected.length > 0) return selected;
  }
  return PRESET_CATEGORIES.filter(c => text.toLowerCase().includes(c.name.toLowerCase()));
}

// ── Onboarding v2 messages (ES/EN) ────────────────────────────────────────────
// First message is bilingual (language not chosen yet); everything after uses
// the user's picked language. Tutorial is split into small chunks on purpose —
// one idea per message, each ending with something to reply to.

const OB_WELCOME = `¡Hola! Soy *Sydney* 👋 Tu asistente personal. / Hi! I'm *Sydney* 👋 Your personal assistant.

🎤 Puedes escribirme por texto o mandarme *notas de voz*, como prefieras. / You can text me or send me *voice notes*, whatever's easier.

Primero lo primero — ¿en qué idioma quieres que hablemos? / First things first — which language should we use?
👉 *español* / *english*`;

const OB = {
  es: {
    askName: () => `Perfecto, español 🙌\n\n¿Cómo quieres que te llame?`,
    askLocation: (n) => `¡Mucho gusto, ${n}! 👋\n\n¿En qué ciudad y país estás?\n(Así te muestro fechas y recordatorios en tu hora local)`,
    tzConfirm: (tz) => `Mmm, no ubico bien esa ciudad 😅 Voy a asumir la zona horaria *${tz}*.\n\n¿Está bien? (responde *sí*, o dime otra ciudad)`,
    tzKept: (tz) => `Ok, dejo *${tz}* por ahora. Si no es la correcta, más adelante solo dime en qué ciudad estás y la ajusto.`,
    tzSaved: (tz) => `✅ Zona horaria: *${tz}*`,
    askBriefs: () => `Un último detalle ⏰\n\nTodo esto que acabamos de ver — tus tareas del día y lo que tengas pendiente — te lo puedo mandar resumido en un *brief*, sin que me lo pidas.\n\nPuedes tener *hasta dos al día*. Lo típico es uno en la mañana (7:00 am) para saber qué viene, y uno en la noche (8:00 pm) para cerrar.\n\n¿Cuáles quieres, y a qué hora?`,
    briefsSet: (m, e, tooMany) => {
      let s;
      if (m && e)      s = `✅ Listo: brief de la mañana a las *${m}* y de la noche a las *${e}*.`;
      else if (m)      s = `✅ Listo: un brief diario en la mañana a las *${m}*.`;
      else if (e)      s = `✅ Listo: un brief diario en la noche a las *${e}*.`;
      else             s = `✅ Ok, sin briefs programados. Si cambias de opinión, solo pídemelo.`;
      if (tooMany) s = `Puedo mandarte *máximo dos al día*, así que me quedé con los dos primeros 🙂\n\n` + s;
      return s + `\n\nY ojo 👀 — no soy solo briefs: escríbeme lo que necesites *a cualquier hora del día* y te respondo al momento.`;
    },
    tutorialTasks: () => `Te muestro rápido cómo funciono — parte 1 de 2 📋\n\n*TAREAS*\nPara agregar una tarea dime qué hay que hacer y para cuándo (hoy, mañana, el viernes, 15-jul…).\n\nEj: _"agrega tarea: revisar el contrato, para el jueves"_\n\nCada tarea va en una *categoría*, para que después las veas ordenadas. Si no me dices cuál, te propongo una y espero tu confirmación antes de guardar. También puedes decirla de una: _"agrega tarea: pagar la luz el viernes, en finanzas"_.\n\nY cuando la termines, dímelo en palabras simples: _"ya la hice"_, _"listo lo del contrato"_ ✅\n\n¿Alguna duda? Respóndeme lo que sea y seguimos.`,
    tutorialDebts: () => `Parte 2 de 2 💰\n\n*DEUDAS*\nTambién llevo el registro de quién te debe y a quién le debes.\n\nEj: _"Juan me debe 50 dólares por un asado"_\nEj: _"le debo a María 200 pesos"_\n\nY cuando se pague: _"ya le pagué a Juan"_ o _"María ya me pagó"_ ✅\n\n¿Todo claro? Respóndeme y elegimos tus categorías.`,
    askCats: (list) => `Ahora tus categorías 📂\n\nSon las que acabo de mencionar: cada tarea va en una. Elige las que uses de esta lista y en el paso siguiente puedes *crear las tuyas*.\n\n${list}\n\nEscribe los números separados por coma (ej: 1, 3, 5) o los nombres.`,
    askCustomCats: (names) => `✅ Categorías guardadas: *${names}*.\n\n¿Quieres agregar alguna categoría tuya? Dime los nombres separados por coma (ej: _Viajes, Iglesia_) — o responde *no*.`,
    customAdded: (names) => `✅ Agregué: *${names}*.`,
    done: (n) => `¡Todo listo, ${n}! 🎉 Cuando quieras, empieza — por texto o nota de voz 🎤`,
  },
  en: {
    askName: () => `Great, English it is 🙌\n\nWhat should I call you?`,
    askLocation: (n) => `Nice to meet you, ${n}! 👋\n\nLet me know your city and country.\n(That way I show dates and reminders in your local time)`,
    tzConfirm: (tz) => `Hmm, I don't recognize that city 😅 I'll assume the *${tz}* timezone.\n\nIs that right? (reply *yes*, or tell me another city)`,
    tzKept: (tz) => `Ok, I'll keep *${tz}* for now. If it's not right, just tell me your city later and I'll fix it.`,
    tzSaved: (tz) => `✅ Timezone: *${tz}*`,
    askBriefs: () => `One last thing ⏰\n\nEverything we just went through — your tasks for the day and whatever is pending — I can send you as a summary, a *brief*, without you asking.\n\nYou can have *up to two a day*. The usual setup is one in the morning (7:00 am) to see what's coming, and one at night (8:00 pm) to wrap up.\n\nWhich ones do you want, and at what times?`,
    briefsSet: (m, e, tooMany) => {
      let s;
      if (m && e)      s = `✅ Done: morning brief at *${m}* and evening brief at *${e}*.`;
      else if (m)      s = `✅ Done: one daily brief in the morning at *${m}*.`;
      else if (e)      s = `✅ Done: one daily brief in the evening at *${e}*.`;
      else             s = `✅ Ok, no scheduled briefs. If you change your mind, just ask.`;
      if (tooMany) s = `I can send you *two a day at most*, so I kept the first two 🙂\n\n` + s;
      return s + `\n\nAnd heads up 👀 — I'm not just briefs: message me whatever you need *at any time of day* and I'll answer right away.`;
    },
    tutorialTasks: () => `Quick tour of how I work — part 1 of 2 📋\n\n*TASKS*\nTo add a task, tell me what needs to get done and by when (today, tomorrow, Friday, 15-Jul…).\n\nE.g.: _"add task: review the contract, due Thursday"_\n\nEvery task lives in a *category*, so you can see them grouped later. If you don't name one, I'll suggest one and wait for your OK before saving. You can also say it upfront: _"add task: pay the electricity bill Friday, in finances"_.\n\nAnd when you finish it, just say so in plain words: _"done"_, _"finished the contract thing"_ ✅\n\nAny questions? Reply anything and we'll keep going.`,
    tutorialDebts: () => `Part 2 of 2 💰\n\n*DEBTS*\nI also keep track of who owes you and who you owe.\n\nE.g.: _"Juan owes me 50 dollars for a barbecue"_\nE.g.: _"I owe María 200 pesos"_\n\nAnd when it's paid: _"I paid Juan back"_ or _"María paid me"_ ✅\n\nAll clear? Reply and let's pick your categories.`,
    askCats: (list) => `Now your categories 📂\n\nThese are the ones I just mentioned: every task goes in one. Pick the ones you use from this list — in the next step you can *create your own*.\n\n${list}\n\nType the numbers separated by commas (e.g. 1, 3, 5) or the names.`,
    askCustomCats: (names) => `✅ Categories saved: *${names}*.\n\nWant to add categories of your own? Tell me the names separated by commas (e.g. _Travel, Church_) — or reply *no*.`,
    customAdded: (names) => `✅ Added: *${names}*.`,
    done: (n) => `All set, ${n}! 🎉 Start whenever you want — text or voice note 🎤`,
  },
};

function parseLanguageChoice(text) {
  const t = (text || '').toLowerCase();
  if (/(espa|spanish|castellano)/.test(t)) return 'es';
  if (/(english|ingl[eé]s|\ben\b|\beng\b)/.test(t)) return 'en';
  return 'es';
}

// Parse the brief-schedule answer: "7am y 8pm", "solo en la mañana a las 7:30",
// "los dos", "no quiero", "a las 8 de la noche" → { morning, evening } as HH:MM
// (empty string = that brief off). Unparseable answers keep the 07:00/20:00
// defaults — the confirmation message always states what was actually set.
function parseBriefTimes(text) {
  const t = (text || '').toLowerCase();
  if (!/\d/.test(t) && /\b(no|ninguno|ningun[ao]|none|nada|nope)\b/.test(t)) return { morning: '', evening: '', tooMany: false };

  // Only two briefs exist (brief_morning, brief_evening). Someone who asks for
  // three — by count word or by naming three times — gets told, instead of
  // silently receiving two.
  const tooMany = /\b(tres|cuatro|cinco|seis|three|four|five|six)\b/.test(t)
    || (t.match(/(\d{1,2})(?::(\d{2}))?(?:\s*[ap]\.?m\.?)?/g) || []).length > 2;

  const found = [];
  const re = /(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?)?/g;
  let m;
  while ((m = re.exec(t)) && found.length < 2) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const mer = m[3] || '';
    if (h > 23 || min > 59) continue;
    if (mer === 'p' && h < 12) h += 12;
    if (mer === 'a' && h === 12) h = 0;
    found.push({ h, min, explicit: !!mer || h > 12 });
  }

  const mentionsMorning = /(ma[ñn]ana|morning|matutin|am\b)/.test(t);
  const mentionsEvening = /(noche|night|evening|tarde|vespertin|diario|pm\b)/.test(t);
  let wantMorning = true, wantEvening = true;
  const onlyOne = /(solo|s[oó]lo|only|just|\buno\b|\bone\b|un brief|1 brief)/.test(t);
  if (onlyOne) {
    if (mentionsMorning && !mentionsEvening) wantEvening = false;
    else if (mentionsEvening && !mentionsMorning) wantMorning = false;
    else if (found.length === 1) { wantEvening = found[0].h >= 12; wantMorning = !wantEvening; }
  }

  const fmt = (x) => `${String(x.h).padStart(2, '0')}:${String(x.min).padStart(2, '0')}`;
  let morning = wantMorning ? '07:00' : '';
  let evening = wantEvening ? '20:00' : '';
  if (found.length === 1) {
    const x = { ...found[0] };
    if (wantMorning && !wantEvening) morning = fmt(x);
    else if (wantEvening && !wantMorning) { if (x.h < 12 && !x.explicit) x.h += 12; evening = fmt(x); }
    else if (x.h < 12) morning = fmt(x);
    else evening = fmt(x);
  } else if (found.length >= 2) {
    let [a, b] = found.map(x => ({ ...x }));
    if (a.h > b.h) [a, b] = [b, a];
    if (wantMorning) morning = fmt(a);
    if (wantEvening) { if (b.h < 12 && !b.explicit) b.h += 12; evening = fmt(b); }
  }
  return { morning, evening, tooMany };
}

function filterToolsForUser(user) {
  const f   = JSON.parse(user.features || '{}');
  const san = String(user.chat_id) === String(cfg.telegram_chat_id);
  return TOOLS.filter(t => {
    const n = t.function.name;
    if (!f.email      && n === 'scan_gmail_for_actions') return false;
    if (!f.calendar   && ['add_calendar_event','update_calendar_event','list_calendar_events','lookup_google_contact'].includes(n)) return false;
    if (!f.networking && ['add_contact','list_contacts','update_contact'].includes(n)) return false;
    if (!f.finanzas   && ['add_debt','list_debts','update_debt_status'].includes(n)) return false;
    if (!f.tasks      && ['list_tasks','add_task','update_task','update_tasks','delete_task','add_category'].includes(n)) return false;
    if (!san          && n === 'get_usage') return false;
    return true;
  });
}

/**
 * The language Sydney answers in.
 *
 * This is a **setting, not an inference**. The prompt used to say "reply in the
 * user's language", which meant it followed whatever language the last message
 * happened to be in — so the preference someone picks in Ajustes did nothing.
 * We cannot change the language of the Telegram app; the language of the
 * conversation is the part we control, so it has to actually obey.
 *
 * Only when nothing has been chosen yet does it fall back to following the user,
 * which is the right behaviour mid-onboarding before the question is asked.
 */
function buildLanguageDirective(user) {
  const language = user && user.language;
  if (language === 'en') return 'Always reply in English, even if the user writes to you in another language.';
  if (language === 'es') return 'Responde siempre en español, aunque el usuario te escriba en otro idioma.';
  return "Reply in the user's language.";
}

function buildSystemPromptForUser(user) {
  const isSantiago = String(user.chat_id) === String(cfg.telegram_chat_id);
  // Santiago's categories used to come from the shared categories.json while
  // everyone else's came from their own row — the last place the two stores
  // could disagree, and they did: the file lists eight, his real tasks use
  // thirteen. Everyone reads the same mirror now.
  if (isSantiago) {
    return SYSTEM_PROMPT
      .replace('__CATEGORIES__', buildCategoriesSectionForUser(user))
      .replace('__LANGUAGE__', buildLanguageDirective(user));
  }

  const preferredName = user.preferred_name || user.name || 'tú';
  const features      = JSON.parse(user.features || '{}');
  const cats          = buildCategoriesSectionForUser(user);

  let prompt = SYSTEM_PROMPT
    .replace('__CATEGORIES__', cats)
    .replace('__LANGUAGE__', buildLanguageDirective(user))
    .replace(/\bSantiago\b/g, preferredName);

  const disabled = [];
  if (!features.email)      disabled.push('scan_gmail_for_actions');
  if (!features.calendar)   disabled.push('add_calendar_event, update_calendar_event, list_calendar_events, lookup_google_contact');
  if (!features.networking) disabled.push('add_contact, list_contacts, update_contact');

  const available = ['tareas', features.finanzas ? 'deudas' : null].filter(Boolean).join(' y ');
  if (disabled.length > 0) {
    prompt += `\n\n== FUNCIONES NO DISPONIBLES ==\nPara este usuario solo están disponibles: ${available}. NO llames ni menciones las tools: ${disabled.join(', ')}.\nSi pide algo que requiere una de esas funciones, NO digas "esa función no está disponible": responde con naturalidad que por ahora le ayudas con ${available}, y ofrece ayudarle con eso. Nunca menciones nombres de tools ni detalles técnicos.`;
  }
  prompt += `\n\n== PRIVACIDAD ==\nEres el asistente personal de ${preferredName} únicamente. Solo tienes acceso a SU información (${available}).\nSi pide ver, modificar o enviar información de otra persona ("las tareas de Santiago", "los otros usuarios"), NUNCA confirmes ni niegues que existan otros usuarios ni sus datos. Responde con neutralidad: solo manejas su información personal, y ofrece mostrarle lo suyo. Ejemplo: "Solo manejo tu información personal — ¿te muestro tus tareas?"`;
  return prompt;
}

// Task isolation is enforced by the API now (2026-09-01): every request carries
// the caller's chat id, the API resolves it to a users row, and every query is
// scoped `WHERE user_id = ?`. A user simply cannot receive someone else's task.
//
// Before that, the Task Dashboard was single-tenant and everything landed on one
// account, so isolation was faked by tagging titles with [uid:CHATID] and
// filtering the tag out here. The tags were migrated away; this only strips any
// straggler so an old title never shows its plumbing to a user.
function filterTaskOutput(text) {
  return text.replace(/\[uid:\d+\]\s*/g, '');
}

// ── Onboarding state machine ──────────────────────────────────────────────────

// F6: the preferred name is later spliced into the system prompt
// (buildSystemPromptForUser) and user-facing cards. Take the first token, keep
// only letters/digits (Unicode-aware) so it can't carry instructions or a [uid:]
// tag, and cap the length. Sanitizing at capture covers every downstream use.
function sanitizeName(raw) {
  const first = (raw || '').trim().split(/\s+/)[0] || '';
  const clean = first.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 30);
  return clean || 'Amigo';
}

async function handleOnboarding(chatId, user, text) {
  let state = user.onboarding;
  if (state === 'awaiting_tz') state = 'awaiting_location'; // legacy pre-v2 state

  const lang = user.language === 'en' ? 'en' : 'es';
  const T = OB[lang];

  if (state === 'new') {
    db.updateUser(chatId, { onboarding: 'awaiting_language' });
    await sendMessage(chatId, OB_WELCOME);
    return;
  }

  if (state === 'awaiting_language') {
    const choice = parseLanguageChoice(text);
    db.updateUser(chatId, { language: choice, onboarding: 'awaiting_name' });
    await sendMessage(chatId, OB[choice].askName());
    return;
  }

  if (state === 'awaiting_name') {
    const name = sanitizeName(text); // first token, sanitized + length-capped (F6)
    db.updateUser(chatId, { preferred_name: name, onboarding: 'awaiting_location' });
    await sendMessage(chatId, T.askLocation(name));
    return;
  }

  if (state === 'awaiting_location') {
    const { tz, matched } = parseCityToTimezone(text);
    if (matched) {
      db.updateUser(chatId, { timezone: tz, onboarding: 'awaiting_tasks_ack' });
      await sendMessage(chatId, T.tzSaved(tz));
      await sendMessage(chatId, T.tutorialTasks());
    } else {
      // Unrecognized city: store the Americas guess and ask before moving on.
      db.updateUser(chatId, { timezone: tz, onboarding: 'awaiting_tz_confirm' });
      await sendMessage(chatId, T.tzConfirm(tz));
    }
    return;
  }

  if (state === 'awaiting_tz_confirm') {
    const yes = /^(s[ií]|yes|ok|dale|correcto|claro|sure|yep|yeah)\b/i.test((text || '').trim());
    let tz = user.timezone;
    if (!yes) {
      const retry = parseCityToTimezone(text);
      if (retry.matched) tz = retry.tz;
      else await sendMessage(chatId, T.tzKept(tz)); // one retry, then keep the guess
    }
    db.updateUser(chatId, { timezone: tz, onboarding: 'awaiting_tasks_ack' });
    await sendMessage(chatId, T.tzSaved(tz));
    await sendMessage(chatId, T.tutorialTasks());
    return;
  }

  if (state === 'awaiting_tasks_ack') { // any reply advances the tutorial
    db.updateUser(chatId, { onboarding: 'awaiting_debts_ack' });
    await sendMessage(chatId, T.tutorialDebts());
    return;
  }

  if (state === 'awaiting_debts_ack') {
    db.updateUser(chatId, { onboarding: 'awaiting_cats' });
    const catList = PRESET_CATEGORIES.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    await sendMessage(chatId, T.askCats(catList));
    return;
  }

  if (state === 'awaiting_cats') {
    const selected = parseCategorySelection(text);
    const cats = selected.length > 0 ? selected : [PRESET_CATEGORIES[0], PRESET_CATEGORIES[PRESET_CATEGORIES.length - 1]];
    db.updateUser(chatId, { categories: JSON.stringify(cats), onboarding: 'awaiting_custom_cat' });
    await sendMessage(chatId, T.askCustomCats(cats.map(c => c.name).join(', ')));
    return;
  }

  if (state === 'awaiting_custom_cat') {
    const answer = (text || '').trim();
    if (!/^(no+|nope|nel|n)\.?$/i.test(answer)) {
      const fresh = db.getUser(chatId) || {};
      const cats = JSON.parse(fresh.categories || '[]');
      const existing = new Set([...cats, ...PRESET_CATEGORIES].map(c => c.name.toLowerCase()));
      const added = [];
      for (const raw of answer.split(',')) {
        const catName = raw.replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 30);
        if (!catName || existing.has(catName.toLowerCase())) continue;
        if (/^(s[ií]|yes|ok|dale|claro|sure)$/i.test(catName)) continue; // filler, not a category
        cats.push({ name: catName, keywords: [] });
        existing.add(catName.toLowerCase());
        added.push(catName);
      }
      if (added.length) {
        db.updateUser(chatId, { categories: JSON.stringify(cats) });
        await sendMessage(chatId, T.customAdded(added.join(', ')));
      }
    }
    // Briefs come last on purpose: the question only makes sense once the user
    // knows what a task is. Asked third, as it was until 2026-09-01, people did
    // not understand what was being summarised.
    db.updateUser(chatId, { onboarding: 'awaiting_briefs' });
    await sendMessage(chatId, T.askBriefs());
    return;
  }

  if (state === 'awaiting_briefs') {
    const { morning, evening, tooMany } = parseBriefTimes(text);
    db.updateUser(chatId, { brief_morning: morning, brief_evening: evening, onboarding: 'done' });
    // Onboarding never blocks on the dashboard: a person finishing setup must
    // not be stopped by an API that is cold. The mirror already holds the
    // answer, and the background sync pushes nothing — so if this fails, the
    // web will not know these times until they are set again. Logged loudly for
    // that reason.
    prefs.push(cfg, chatId, {
      briefMorning: morning || '',
      briefEvening: evening || '',
      language: lang === 'en' ? 'en' : 'es',
      timezone: (db.getUser(chatId) || {}).timezone || 'America/Los_Angeles'
    }).catch(err => console.log(`[prefs] onboarding push failed for ${chatId}: ${err.message}`));
    scheduleCrons(); // user is now 'done' → give them their brief crons
    await sendMessage(chatId, T.briefsSet(morning, evening, tooMany));
    const name = (db.getUser(chatId) || {}).preferred_name || (lang === 'en' ? 'you' : 'tú');
    await sendMessage(chatId, T.done(name));
    return;
  }
}

// ── Admin commands (Santiago only): /users, /resetuser, /deleteuser ──────────

function describeUser(u) {
  const feats = Object.entries(JSON.parse(u.features || '{}'))
    .filter(([, v]) => v).map(([k]) => k).join(',') || '—';
  return `• *${u.preferred_name || u.name || '?'}* (${u.name || '?'}) — id <code>${u.chat_id}</code>\n` +
         `  ${u.onboarding} | ${u.timezone} | ${u.language || 'auto'} | briefs ${u.brief_morning || 'off'}/${u.brief_evening || 'off'} | ${feats}`;
}

async function handleAdminCommand(chatId, text) {
  const [cmd, idArg, confirmArg] = text.trim().split(/\s+/);

  if (cmd === '/users') {
    const users = db.listUsers();
    await sendMessage(chatId,
      `👥 Usuarios (${users.length}):\n${users.map(describeUser).join('\n')}\n\n` +
      `Comandos:\n/resetuser <id> — repite el onboarding (conserva tareas/deudas/datos)\n/deleteuser <id> confirm — elimina la cuenta y sus deudas`);
    return;
  }

  const targetId = parseInt(idArg, 10);
  if (!targetId) { await sendMessage(chatId, `Uso: ${cmd} <chat_id> — saca el id de /users.`); return; }
  if (String(targetId) === String(cfg.telegram_chat_id)) {
    await sendMessage(chatId, '🚫 No puedes aplicar esto a tu propia cuenta.');
    return;
  }
  const target = db.getUser(targetId);
  if (!target) { await sendMessage(chatId, `No existe un usuario con id ${targetId}. Revisa /users.`); return; }
  const label = target.preferred_name || target.name || targetId;

  if (cmd === '/resetuser') {
    db.updateUser(targetId, { onboarding: 'new' });
    delete histories[targetId];
    scheduleCrons(); // non-done users get no brief crons until they finish again
    await sendMessage(chatId, `🔄 Onboarding de *${label}* reiniciado — le mando la bienvenida ahora. Sus tareas, deudas y datos se conservan.`);
    await handleOnboarding(targetId, db.getUser(targetId), '');
    return;
  }

  if (cmd === '/deleteuser') {
    if (confirmArg !== 'confirm') {
      await sendMessage(chatId,
        `⚠️ Vas a eliminar a *${label}* (id ${targetId}): se borra su cuenta y sus deudas; sus tareas del dashboard quedan huérfanas (nadie las verá). Para confirmar envía:\n/deleteuser ${targetId} confirm`);
      return;
    }
    const res = db.deleteUser(targetId);
    delete histories[targetId];
    scheduleCrons();
    await sendMessage(chatId, `🗑️ Usuario *${label}* eliminado (${res.debtsDeleted} deudas borradas). Para volver a entrar necesitará un nuevo /invite.`);
    return;
  }
}

// ── Invite email (Gmail API direct call) ─────────────────────────────────────

async function sendInviteEmail(to, label, link) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.google_client_id, client_secret: cfg.google_client_secret,
      refresh_token: cfg.google_refresh_token, grant_type: 'refresh_token',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Gmail token refresh failed');

  const subject = 'Te invitaron a Sydney — tu asistente personal';
  const body    = `Hola ${label},\n\nTe invitaron a usar Sydney, un asistente personal inteligente en Telegram.\n\nHaz clic aquí para comenzar:\n${link}\n\n(El link es válido por 30 días. Si no tienes Telegram instalado, también funciona en tu navegador en web.telegram.org)\n\n— Santiago`;
  const raw     = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  const encoded = Buffer.from(raw).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  const result = await res.json();
  if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
  return result;
}

// ── OpenAI tools ──────────────────────────────────────────────────────────────

// Shared by add_task and update_task. This field used to be an undescribed free-text
// string, so the model treated it as a dumping ground for leftover words of the user's
// message (a voice note saying "con vencimiento mañana" was transcribed "Convencimiento
// mañana" and landed here verbatim on three tasks). Keep it explicitly opt-in.
const NEXT_STEP_FIELD_DESC =
  'OPTIONAL. A concrete follow-up action the user EXPLICITLY stated as the next step ' +
  '(e.g. "llamar antes del viernes", "mandar el borrador primero"). Omit the field ' +
  'entirely when the user did not state one — an empty nextStep is the correct default. ' +
  'NEVER put leftover or unparsed words from the user message here, never restate the ' +
  'task itself, and never put due-date wording here (dates belong in dueDateNextStep).';

const TOOLS = [
  { type:'function', function:{ name:'list_tasks', description:'List tasks with optional filter', parameters:{ type:'object', properties:{ filter:{ type:'string', enum:['all','pending','today','tomorrow','this_week','overdue','overdue_and_today','overdue_today_tomorrow','on_hold'] }, section:{ type:'string' } } } } },
  { type:'function', function:{ name:'add_task', description:'Add a new task', parameters:{ type:'object', properties:{ toDo:{type:'string'}, dueDateNextStep:{type:'string', description:'Due date, YYYY-MM-DD'}, tipo:{type:'string'}, nextStep:{type:'string', description:NEXT_STEP_FIELD_DESC}, isPriority:{type:'boolean'}, recurrenceInterval:{type:'number'}, recurrenceUnit:{type:'string'} }, required:['toDo','tipo'] } } },
  { type:'function', function:{ name:'update_task', description:'Update a single task by taskId', parameters:{ type:'object', properties:{ taskId:{type:'number'}, toDo:{type:'string'}, statusFinalOutcome:{type:'string'}, dueDateNextStep:{type:'string', description:'Due date, YYYY-MM-DD'}, tipo:{type:'string'}, nextStep:{type:'string', description:NEXT_STEP_FIELD_DESC}, isPriority:{type:'boolean'} }, required:['taskId'] } } },
  { type:'function', function:{ name:'update_tasks', description:'Batch update multiple tasks at once', parameters:{ type:'object', properties:{ updates:{ type:'array', items:{ type:'object', properties:{ taskId:{type:'number'}, toDo:{type:'string'}, statusFinalOutcome:{type:'string'}, dueDateNextStep:{type:'string'}, isPriority:{type:'boolean'} }, required:['taskId'] } } }, required:['updates'] } } },
  { type:'function', function:{ name:'delete_task', description:'Delete a task by taskId', parameters:{ type:'object', properties:{ taskId:{type:'number'} }, required:['taskId'] } } },
  { type:'function', function:{ name:'get_usage', description:'Get estimated token usage and cost for a given month. Use when user asks: cuánto hemos gastado, uso de tokens, costo de mayo, reporte de OpenAI, cuánto costó el mes, how much have we spent, monthly cost.', parameters:{ type:'object', properties:{ month:{ type:'string', description:'Month in YYYY-MM format, e.g. "2026-05". Default: current month.' } } } } },
  { type:'function', function:{ name:'add_calendar_event', description:'Add event to Berkeley calendar', parameters:{ type:'object', properties:{ title:{type:'string'}, date:{type:'string'}, time:{type:'string'}, duration_minutes:{type:'number'}, description:{type:'string'}, attendees:{type:'array',items:{type:'string'},description:'Confirmed attendee email addresses'} }, required:['title','date','time'] } } },
  { type:'function', function:{ name:'update_calendar_event', description:'Update an existing calendar event (add attendees, change title/description). Use this when the event already exists — NEVER use add_calendar_event for modifications. Requires event_id from list_calendar_events [eid:xxx].', parameters:{ type:'object', properties:{ event_id:{type:'string'}, add_attendees:{type:'array',items:{type:'string'},description:'Emails to add'}, title:{type:'string'}, description:{type:'string'} }, required:['event_id'] } } },
  { type:'function', function:{ name:'list_calendar_events', description:'List upcoming calendar events', parameters:{ type:'object', properties:{ days_ahead:{type:'number'} } } } },
  { type:'function', function:{ name:'scan_gmail_for_actions', description:'Scan Gmail for actionable emails', parameters:{ type:'object', properties:{ account:{type:'string', enum:['personal','berkeley','all']}, max_emails:{type:'number'}, newer_than_days:{type:'number'} } } } },
  { type:'function', function:{ name:'update_timezone', description:'Update the bot timezone and reschedule morning/evening briefs. Call when user says they are traveling or in a different city/country.', parameters:{ type:'object', properties:{ timezone:{type:'string', description:'IANA timezone string e.g. America/Santiago'} }, required:['timezone'] } } },
  { type:'function', function:{ name:'update_brief_times', description:'Change when the user receives their morning/evening briefs, or disable one. Call when user asks to change brief times, stop receiving briefs, or move their daily summary to another hour.', parameters:{ type:'object', properties:{ morning:{type:'string', description:'HH:MM 24h, or empty string to disable the morning brief'}, evening:{type:'string', description:'HH:MM 24h, or empty string to disable the evening brief'} } } } },
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
// Node's https has NO default socket timeout: if Telegram accepts the connection
// and never answers (observed as a 504 on getFile, 2026-08-26), the promise never
// settles and the caller's per-chat FIFO queue wedges until a restart. Every call
// gets a deadline. Long-polling getUpdates passes its own, longer one.
function tgRequest(method, body, timeoutMs = 20000) {
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
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Telegram ${method} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Telegram HTML rendering ───────────────────────────────────────────────────
// The bot writes *bold* / _italic_ markdown everywhere (prompt, onboarding,
// briefs). Until 2026-09-01 sendMessage never passed parse_mode, so all of it
// reached users as literal asterisks.
//
// We render to HTML rather than Markdown because HTML only needs & < > escaped,
// while Markdown breaks on any stray * _ [ in a user's own task title and makes
// Telegram reject the whole message.
const TG_ALLOWED_TAGS = ['b', 'i', 'u', 's', 'code', 'pre'];

// Escape everything first, then re-open only the tags we emit ourselves. Content
// that came from a user can never introduce markup this way.
function toTelegramHtml(text) {
  let out = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // *bold* — must hug non-space so "2 * 3" is left alone
  out = out.replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '<b>$1</b>');
  // _italic_ — only when the underscores stand at word edges, so IANA zones like
  // America/Los_Angeles and New_York survive untouched
  out = out.replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  for (const t of TG_ALLOWED_TAGS) {
    out = out.replace(new RegExp(`&lt;${t}&gt;`, 'g'), `<${t}>`)
             .replace(new RegExp(`&lt;/${t}&gt;`, 'g'), `</${t}>`);
  }
  return out;
}

// Same marker rules, but stripped instead of tagged — used when HTML is rejected.
function toPlainText(text) {
  return String(text)
    .replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '$1')
    .replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=[\s).,!?:;]|$)/g, '$1$2');
}

// Split on line boundaries, never mid-tag. 3500 leaves headroom for the growth
// escaping adds (& becomes &amp;) within Telegram's 4096 limit.
function splitForTelegram(text, max = 3500) {
  if (text.length <= max) return [text];
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (line.length > max) {                       // pathological single line
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + line.length + 1 > max) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function sendMessage(chatId, text) {
  let last;
  for (const chunk of splitForTelegram(String(text ?? ''))) {
    last = await tgRequest('sendMessage', {
      chat_id: chatId, text: toTelegramHtml(chunk), parse_mode: 'HTML',
    });
    // A brief must never be lost to one odd character: fall back to plain text.
    if (last && last.ok === false) {
      console.error(`[send] HTML rejected (${last.description || '?'}) — resending as plain text`);
      last = await tgRequest('sendMessage', { chat_id: chatId, text: toPlainText(chunk) });
    }
  }
  return last;
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
// Health/monthly crons are global (cfg.timezone). Briefs are per user: each
// onboarded user gets crons at their own brief_morning/brief_evening times in
// their own timezone. Rebuilt on start, onboarding completion, and any
// timezone/brief-time change.
let cronHealth, cronMonthEnd;
let userBriefCrons = [];

function scheduleCrons() {
  const tz = cfg.timezone || 'America/Los_Angeles';
  if (cronHealth)   cronHealth.destroy();
  if (cronMonthEnd) cronMonthEnd.destroy();
  for (const c of userBriefCrons) c.destroy();
  userBriefCrons = [];
  cronHealth   = cron.schedule('0 2 * * *', runHealthCheck,         { timezone: tz });
  cronMonthEnd = cron.schedule('0 9 1 * *', sendMonthlyUsageReport, { timezone: tz });

  const users = db.getDoneUsers();
  for (const u of users) {
    const utz = u.timezone || tz;
    const addBrief = (hhmm, type) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
      if (!m) return; // empty/invalid = brief disabled for this user
      userBriefCrons.push(cron.schedule(`${+m[2]} ${+m[1]} * * *`, () => sendBriefing(type, u.chat_id), { timezone: utz }));
    };
    addBrief(u.brief_morning, 'morning');
    addBrief(u.brief_evening, 'evening');
  }
  console.log(`[cron] health/monthly tz=${tz}; briefs scheduled for ${users.length} users (${userBriefCrons.length} crons)`);
}

async function doUpdateTimezone({ timezone }, chatId) {
  if (!timezone) return 'Error: timezone string required';
  if (chatId) {
    try {
      await prefs.push(cfg, chatId, { timezone });
    } catch (err) {
      console.log(`[prefs] timezone push failed for ${chatId}: ${err.message}`);
      return 'No pude guardar el cambio de zona horaria ahora mismo. Inténtalo en un momento.';
    }
  }
  // cfg.timezone stays Santiago's zone — it drives the global health/monthly
  // crons and the calendar timezone check.
  if (!chatId || String(chatId) === String(cfg.telegram_chat_id)) {
    cfg.timezone = timezone;
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  }
  scheduleCrons();
  console.log(`[timezone] ${chatId || 'global'} → ${timezone}`);
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
      await doUpdateTimezone({ timezone: calTz }, cfg.telegram_chat_id);
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
const SHEETS_TOOLS = ['add_contact','list_contacts','update_contact']; // finance moved to SQLite

// Server-side authorization: which feature flag each tool requires. Tools absent
// from this map are either Santiago-only (get_usage) or ungated (update_timezone).
// This backstops filterToolsForUser() — never trust the tool list alone.
const TOOL_FEATURE = {
  list_tasks:'tasks', add_task:'tasks', update_task:'tasks', update_tasks:'tasks', delete_task:'tasks', add_category:'tasks',
  add_debt:'finanzas', list_debts:'finanzas', update_debt_status:'finanzas',
  add_calendar_event:'calendar', update_calendar_event:'calendar', list_calendar_events:'calendar', lookup_google_contact:'calendar',
  scan_gmail_for_actions:'email',
  add_contact:'networking', list_contacts:'networking', update_contact:'networking',
};
// Directive, not user-facing text: only ever returned as a role:'tool' result,
// so the model paraphrases it naturally instead of parroting a canned sentence.
const FEATURE_DENIED = '(Esta tool no está habilitada para este usuario. Explica con amabilidad que por ahora solo puedes ayudarle con sus tareas y deudas — sin mencionar tools ni detalles técnicos.)';

// Directive, not user-facing: mirrors FEATURE_DENIED's shape. Returned only as a
// role:'tool' result so the model reacts by asking/confirming a category itself,
// per the RULES text at lines 180-190 — never a canned string shown to the user.
const ADD_TASK_NEEDS_CATEGORY =
  '(No se creó la tarea porque falta "tipo" (categoría). Pregunta al usuario qué categoría usar ' +
  '-- o, si ya la habías inferido en este turno, pide su confirmación explícita -- y NO llames ' +
  'add_task de nuevo hasta tener un tipo confirmado. No menciones "tools", "campos" ni detalles ' +
  'técnicos; simplemente continúa la conversación de forma natural.)';

// The app-level ownership check that used to live here (security item F1) was a
// workaround for a single-tenant API: it fetched every task and compared
// [uid:CHATID] tags before allowing an update or delete. Since 2026-09-01 the API
// scopes each request to the caller's own user row, so a mutation aimed at
// someone else's task returns 404 from the database itself — a stronger guarantee
// than a string comparison in this process, and one that cannot be bypassed by a
// bug in the bot. Verified by an authenticated cross-user request returning 404.

async function callTool(name, args, chatId) {
  const isSantiago = String(chatId) === String(cfg.telegram_chat_id);
  try {
    // ── F5: server-side authorization re-check (defense-in-depth) ─────────────
    // Do not rely solely on the tool list sent to OpenAI. Re-verify the caller's
    // feature flags here so a stray/injected tool name can never execute.
    if (!isSantiago) {
      if (name === 'get_usage') return FEATURE_DENIED;
      const reqFeat = TOOL_FEATURE[name];
      if (reqFeat) {
        const u = db.getUser(chatId);
        const features = u ? JSON.parse(u.features || '{}') : {};
        if (!features[reqFeat]) return FEATURE_DENIED;
      }
    }

    // ── Category-integrity guard (bug fix: silent "Otros" default on add_task) ──
    // Scoped to add_task only — never update_task (own guardrails) or calendar tools.
    if (name === 'add_task') {
      const tipo = args.tipo;
      if (tipo === undefined || tipo === null || String(tipo).trim() === '') {
        return ADD_TASK_NEEDS_CATEGORY;
      }
    }

    // ── Finance: SQLite per-user (replaces sheets-mcp finance tools) ──────────
    // Las deudas viven en Postgres desde 2026-09-10, igual que las
    // preferencias — antes solo estaban en la SQLite de esta VM y la web no
    // podía mostrarlas. Si la API no responde se lo decimos en vez de contestar
    // con una lista vieja: una deuda que ya se pagó y sigue apareciendo hace
    // que alguien cobre dos veces.
    if (name === 'add_debt' || name === 'list_debts' || name === 'update_debt_status') {
      try {
        if (name === 'add_debt')   return await prefs.addDebt(cfg, chatId, args);
        if (name === 'list_debts') return await prefs.listDebts(cfg, chatId, args.filter);
        return await prefs.updateDebt(cfg, chatId, args.row, args.status);
      } catch (err) {
        console.log(`[debts] ${name} falló para ${chatId}: ${err.message}`);
        return 'No pude llegar a tus finanzas ahora mismo. Inténtalo en un momento.';
      }
    }

    // ── Timezone: per-user row (+ global cfg when Santiago), reschedules briefs ─
    if (name === 'update_timezone') {
      return await doUpdateTimezone(args, chatId);
    }

    // ── Brief times: per-user schedule (HH:MM 24h, empty string = off) ────────
    if (name === 'update_brief_times') {
      const valid = v => v === '' || /^([01]?\d|2[0-3]):[0-5]\d$/.test(v);
      const upd = {};
      if (args.morning !== undefined) { if (!valid(args.morning)) return 'Formato inválido — usa HH:MM (24h) o "" para desactivar.'; upd.brief_morning = args.morning; }
      if (args.evening !== undefined) { if (!valid(args.evening)) return 'Formato inválido — usa HH:MM (24h) o "" para desactivar.'; upd.brief_evening = args.evening; }
      if (!Object.keys(upd).length) return 'Nada que actualizar — pasa morning y/o evening.';
      // Postgres first: if it refuses, the mirror keeps the old value and the
      // two never disagree in the direction where the bot believes something
      // that was never stored.
      try {
        await prefs.push(cfg, chatId, {
          ...(upd.brief_morning !== undefined ? { briefMorning: upd.brief_morning } : {}),
          ...(upd.brief_evening !== undefined ? { briefEvening: upd.brief_evening } : {})
        });
      } catch (err) {
        console.log(`[prefs] push failed for ${chatId}: ${err.message}`);
        return 'No pude guardar el cambio ahora mismo. Inténtalo en un momento.';
      }
      scheduleCrons();
      const u = db.getUser(chatId);
      return `✅ Briefs actualizados: mañana ${u.brief_morning || 'desactivado'} / noche ${u.brief_evening || 'desactivado'}.`;
    }

    // ── add_category: update user DB record for non-Santiago users ────────────
    if (name === 'add_category' && !isSantiago) {
      const { name: catName, keywords = [] } = args;
      const user = db.getUser(chatId);
      const cats = JSON.parse(user.categories || '[]');
      if (!cats.find(c => c.name === catName)) cats.push({ name: catName, keywords });
      try {
        await prefs.push(cfg, chatId, {
          tipoOptions: cats.map(c => c.name).filter(Boolean),
          categoryKeywords: Object.fromEntries(
            cats.filter(c => c.keywords && c.keywords.length).map(c => [c.name, c.keywords])
          )
        });
      } catch (err) {
        console.log(`[prefs] category push failed for ${chatId}: ${err.message}`);
        return 'No pude guardar la categoría ahora mismo. Inténtalo en un momento.';
      }
      return `✅ Categoría "${catName}" creada. Ya disponible en la próxima conversación y en la web.`;
    }

    // ── Tell the Task API which user this call is for ────────────────────────
    // One MCP process serves every user, so the caller's identity has to travel
    // with the call. tasks-mcp.js strips _chatId off the arguments and turns it
    // into an X-Telegram-Chat-Id header. It is injected here, never exposed to
    // the model as a tool parameter.
    if (TASK_TOOLS.includes(name)) {
      args = { ...args, _chatId: String(chatId) };
    }

    // ── Route to MCP server ──────────────────────────────────────────────────
    const proc = TASK_TOOLS.includes(name) ? taskServer
               : CAL_TOOLS.includes(name) ? calendarServer
               : SHEETS_TOOLS.includes(name) ? sheetsServer
               : null;
    const map  = TASK_TOOLS.includes(name) ? taskPending
               : SHEETS_TOOLS.includes(name) ? sheetsPending
               : calPending;
    if (!proc) return `Unknown tool: ${name}`;
    const result = await callMCP(proc, map, name, args);
    let text = result?.content ? result.content.map(c => c.text || JSON.stringify(c)).join('\n')
                               : JSON.stringify(result);

    // ── Task output: filter to only this user's tasks ─────────────────────────
    if (name === 'list_tasks') text = filterTaskOutput(text);

    return text;
  } catch (err) { return `Tool error: ${err.message}`; }
}

// ── Conversation history ──────────────────────────────────────────────────────
const histories = {};
function getHistory(chatId) {
  if (!histories[chatId]) histories[chatId] = [];
  return histories[chatId];
}

// F8: per-user sliding-window rate limit guarding the expensive OpenAI/Whisper
// path — caps runaway cost from an abusive or compromised account. Overridable
// via cfg.rate_limit_max / cfg.rate_limit_window_ms. Santiago is exempt.
const rateWindows = new Map(); // chatId -> [timestamps within window]
function allowMessage(chatId) {
  const max   = cfg.rate_limit_max ?? 30;
  const winMs = cfg.rate_limit_window_ms ?? 10 * 60 * 1000;
  const now   = Date.now();
  const arr   = (rateWindows.get(chatId) || []).filter(t => now - t < winMs);
  if (arr.length >= max) { rateWindows.set(chatId, arr); return false; }
  arr.push(now);
  rateWindows.set(chatId, arr);
  return true;
}

// F3: throttle invite-code brute forcing. After MAX failed /start claims within
// WINDOW from one chat, ignore further claims from it for COOLDOWN. A brute-forcer
// would need many distinct Telegram accounts to get around this.
const inviteFails = new Map(); // chatId -> { count, first, blockedUntil }
function inviteThrottled(chatId) {
  const rec = inviteFails.get(chatId);
  return !!(rec && rec.blockedUntil && Date.now() < rec.blockedUntil);
}
function recordInviteFail(chatId) {
  const WINDOW = 10 * 60 * 1000, MAX = 5, COOLDOWN = 30 * 60 * 1000;
  const now = Date.now();
  let rec = inviteFails.get(chatId);
  if (!rec || now - rec.first > WINDOW) rec = { count: 0, first: now, blockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX) rec.blockedUntil = now + COOLDOWN;
  inviteFails.set(chatId, rec);
}

// ── OpenAI request builder ────────────────────────────────────────────────────
// Single place to build the completion request so the three call sites in a turn
// (initial, tool loop, guard retry) can never drift apart.
//
// GPT-5 family only: reasoning_effort. Measured 2026-08-12 on this exact prompt
// shape — "minimal" REPRODUCED the bug this guard exists for (it answered "voy a
// marcar las tareas..." and emitted NO tool call), so never set it. "low" keeps
// tool-calling reliable at ~2.6s. Reasoning tokens bill as output tokens.
function chatCreate(messages, tools) {
  const model = cfg.openai_model;
  const req = { model, messages, tools, tool_choice:'auto' };
  const effort = cfg.openai_reasoning_effort;
  if (/^gpt-5/.test(model || '') && effort && effort !== 'minimal') req.reasoning_effort = effort;
  return openai.chat.completions.create(req);
}

// ── Mutation-claim guard ──────────────────────────────────────────────────────
// Smaller models sometimes NARRATE a completed action ("marqué la tarea como
// hecha") without ever emitting the tool call, so nothing is actually written.
// Prompt rules against this have failed repeatedly (Jun 2026, Aug 2026), so the
// check lives in code: if the reply claims a mutation but no mutating tool ran
// successfully this turn, force one corrective retry before anything is sent.
const MUTATING_TOOLS = new Set([
  'update_task','update_tasks','delete_task','add_task','add_category',
  'add_debt','update_debt_status',
  'add_contact','update_contact',
  'add_calendar_event','update_calendar_event','send_email',
]);

// A tool result counts as a real mutation only if it is not one of our failure
// or refusal strings. '(' catches the FEATURE_DENIED directive.
function toolFailed(result) {
  if (typeof result !== 'string') return true;
  // Partial batch write (emitted by tasks-mcp update_tasks): some rows DID
  // change, so this counts as a real mutation. The model still has the per-task
  // errors in the result text and must report them — but the claim guard must
  // NOT overwrite that with "nothing was changed", which would be false.
  if (/^⚠️ Solo \d+ de \d+/.test(result)) return false;
  return /^(Tool error|Unknown tool|No se encontr|No pude verificar|Formato inválido|Nada que actualizar|❌|⚠️|\()/.test(result);
}

// First-person past tense + past participles + "ya quedó/está listo" phrasings.
// Deliberately broad: a false positive costs one extra LLM round-trip, while a
// false negative sends the user a lie.
// NOTE: \b is useless next to accented letters (é is not \w in JS regex), which
// silently missed "Marqué"/"eliminé"/"moví". Use Unicode letter lookarounds.
const NL0 = '(?<!\\p{L})', NL1 = '(?!\\p{L})';
const CLAIM_RE = new RegExp([
  // First-person preterite — accent required, so the subjunctive ("que marque")
  // and English "complete" don't collide.
  NL0 + '(marqué|completé|eliminé|borré|moví|actualicé|agregué|añadí|registré|creé|guardé|dejé)' + NL1,
  // Past participles ("marcadas como hechas", "tareas eliminadas").
  NL0 + '(marcad|completad|eliminad|borrad|movid|actualizad|agregad|añadid|registrad|cread|guardad|hech)[oa]s?' + NL1,
  NL0 + '(marked|completed|deleted|removed|moved|updated|added|created|saved)' + NL1,
  '(ya )?(est[áa]n?|qued[óo]|quedaron|quedó) (list[oa]s?|hech[oa]s?)',
].join('|'), 'iu');

// Only DECLARATIVE sentences can be claims. "¿Quieres que la marque como hecha?"
// is an offer, so interrogative clauses are stripped before matching.
function claimsMutation(text) {
  if (!text) return false;
  const declarative = text
    .split(/(?<=[.!?\n])/)
    .filter(s => !s.includes('¿') && !/\?\s*$/.test(s.trim()))
    .join(' ');
  return CLAIM_RE.test(declarative);
}

const GUARD_CORRECTION = 'VERIFICACIÓN AUTOMÁTICA DEL SISTEMA: tu respuesta afirma haber realizado una acción (marcar, mover, eliminar, agregar o actualizar), pero NO emitiste ninguna tool call en este turno, así que NADA cambió en la base de datos. Si el usuario pidió esa acción, EJECÚTALA AHORA emitiendo la tool correcta (llama list_tasks primero para obtener los [#N] reales si aplica). Si no corresponde ejecutarla, reescribe tu respuesta SIN afirmar que hiciste algo.';

// ── All-done celebration ──────────────────────────────────────────────────────
// Deterministic Duolingo-style hype: after a turn that marked tasks Done, re-list
// the user's pending-today tasks and send a separate message if zero remain.
const CELEBRATIONS = {
  es: [
    '🎉 ¡BOOM! ¡Terminaste TODAS tus tareas de hoy! 🔥',
    '🏆 ¡Cero pendientes! Día dominado 💪',
    '✨ ¡Lista limpia! Eres imparable 🚀',
    '🥳 ¡Todo hecho! Hoy ganaste tú 🏅',
  ],
  en: [
    "🎉 BOOM! ALL your tasks for today are DONE! 🔥",
    '🏆 Zero pending — you crushed today 💪',
    '✨ Clean list! Unstoppable 🚀',
    '🥳 Everything done — today, you won 🏅',
  ],
};
function pickCelebration(lang) {
  const list = CELEBRATIONS[lang === 'en' ? 'en' : 'es'];
  return list[Math.floor(Math.random() * list.length)];
}

// True when a tool call's args mark at least one task as Done.
function marksTaskDone(name, args) {
  if (name === 'update_task')  return args.statusFinalOutcome === 'Done';
  if (name === 'update_tasks') return (Array.isArray(args.updates) ? args.updates : []).some(u => u && u.statusFinalOutcome === 'Done');
  return false;
}

async function maybeCelebrate(chatId, user) {
  try {
    const features = JSON.parse(user.features || '{}');
    if (!features.tasks) return;
    const list = await callTool('list_tasks', { filter: 'overdue_and_today' }, chatId);
    if (typeof list !== 'string' || list.startsWith('Tool error')) return;
    if (/ \[#\d+\]/.test(list)) return; // still has pending tasks
    await sendMessage(chatId, pickCelebration(user.language));
  } catch (e) { console.error('[celebration]', e.message); }
}

// ── Main LLM handler ──────────────────────────────────────────────────────────
async function handleMessage(chatId, userText) {
  const user = db.getUser(chatId);
  if (!user) return;

  // Route to onboarding if not complete
  if (user.onboarding !== 'done') {
    await handleOnboarding(chatId, user, userText);
    return;
  }

  // F8: rate-limit the expensive path (Santiago exempt).
  const isSantiago = String(chatId) === String(cfg.telegram_chat_id);
  if (!isSantiago && !allowMessage(chatId)) {
    await sendMessage(chatId, '⏳ Has enviado muchos mensajes seguidos. Intenta de nuevo en unos minutos.');
    return;
  }

  const history = getHistory(chatId);
  history.push({ role:'user', content:userText });
  if (history.length > 20) history.splice(0, history.length - 20);

  const tz = user.timezone || cfg.timezone || 'America/Los_Angeles';
  const now = new Date();
  const todayISO      = now.toLocaleDateString('en-CA', { timeZone: tz });
  const todayReadable = now.toLocaleDateString(user.language === 'en' ? 'en-US' : 'es-MX', { timeZone: tz, weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const curYear  = parseInt(todayISO.slice(0, 4), 10);
  const curMonth = parseInt(todayISO.slice(5, 7), 10);
  let dateBlock = `\n\n== FECHA ACTUAL ==\nHoy es ${todayReadable} (${todayISO}). Usa esta fecha para calcular "hoy", "mañana", "el miércoles", "la próxima semana", etc.
REGLAS DE AÑO:
- Las tareas son SIEMPRE para hoy o el futuro — nunca guardes una fecha límite en el pasado.
- Fecha sin año → asume ${curYear}. Si ese día ya pasó este año, asume la próxima ocurrencia (${curYear + 1}) y menciónalo al confirmar.
- Si el usuario dice explícitamente ${curYear} o ${curYear + 1}, acéptalo sin cuestionar. Solo aclara si da un año claramente pasado.`;
  // Year-end ambiguity window: with <2 months left, "el 15 de enero" is genuinely
  // ambiguous — ask instead of assuming.
  if (curMonth >= 11) dateBlock += `\n- Queda poco para el fin de año: si el usuario da una fecha SIN año, PREGUNTA a qué año se refiere antes de guardar.`;
  const systemWithDate = buildSystemPromptForUser(user) + dateBlock;
  const messages    = [{ role:'system', content:systemWithDate }, ...history];
  const userTools   = filterToolsForUser(user);
  const deadline    = Date.now() + 55000;
  let markedDone    = false;
  let ranMutation   = false;
  let guardRetried  = false;

  try {
    let response = await chatCreate(messages, userTools);
    if (response.usage) logUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
    let msg = response.choices[0].message;
    messages.push(msg);

    let reply;
    for (;;) {
      while (msg.tool_calls?.length && Date.now() < deadline) {
        const results = await Promise.all(msg.tool_calls.map(async tc => {
          const args = JSON.parse(tc.function.arguments || '{}');
          console.log(`[tool] ${tc.function.name}`, JSON.stringify(args).slice(0,80));
          const result = await callTool(tc.function.name, args, chatId);
          const failed = toolFailed(result);
          console.log(`[tool:done] ${tc.function.name} ${failed ? 'FAILED' : 'ok'}`, String(result).slice(0,120));
          if (!failed && MUTATING_TOOLS.has(tc.function.name)) ranMutation = true;
          if (!failed && marksTaskDone(tc.function.name, args)) markedDone = true;
          return { tool_call_id:tc.id, role:'tool', content:result };
        }));
        messages.push(...results);

        if (Date.now() >= deadline) {
          await sendMessage(chatId, '⚠️ Tardé demasiado. Intenta de nuevo.');
          return;
        }

        response = await chatCreate(messages, userTools);
        if (response.usage) logUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
        msg = response.choices[0].message;
        messages.push(msg);
      }

      reply = msg.content || '(sin respuesta)';

      // Guard: the reply claims an action but nothing was actually written.
      // Give the model exactly one chance to either perform it or retract it.
      if (!guardRetried && !ranMutation && claimsMutation(reply) && Date.now() < deadline) {
        guardRetried = true;
        console.warn(`[guard] unverified mutation claim → forcing retry (chat ${chatId}):`, reply.slice(0, 120));
        messages.push({ role:'system', content:GUARD_CORRECTION });
        response = await chatCreate(messages, userTools);
        if (response.usage) logUsage(response.usage.prompt_tokens, response.usage.completion_tokens);
        msg = response.choices[0].message;
        messages.push(msg);
        continue;
      }

      // Retry happened and STILL nothing was written: never send the false claim.
      if (guardRetried && !ranMutation && claimsMutation(reply)) {
        console.error(`[guard] claim survived retry — suppressing (chat ${chatId})`);
        reply = user.language === 'en'
          ? '⚠️ I could not complete that action — nothing was changed. Please try again, ideally naming the task exactly.'
          : '⚠️ No pude completar esa acción — no se cambió nada. Inténtalo de nuevo, ojalá nombrando la tarea exacta.';
      }
      break;
    }

    history.push({ role:'assistant', content:reply });
    await sendMessage(chatId, reply);
    console.log(`[reply → ${chatId}]`, reply.slice(0, 100));
    if (markedDone) await maybeCelebrate(chatId, user);
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

function buildBriefingText(type, features) {
  const f = features;
  if (type === 'morning') {
    const parts  = ['Buenos días. Dame mi resumen matutino siguiendo el formato de FORMAT RULES:'];
    const calls  = [];
    const sects  = [];
    if (f.calendar)                              { calls.push('list_calendar_events con days_ahead 1 (muestra solo eventos de HOY; si no hay, escribe exactamente "Sin eventos hoy")'); sects.push('📅 AGENDA HOY'); }
    if (f.tasks)                                 { calls.push('list_tasks con filter overdue_and_today'); sects.push('✅ TAREAS agrupadas por categoría'); }
    if (f.email && cfg.morning_emails_paused !== true) { calls.push('scan_gmail_for_actions con account all y newer_than_days 2 (si no hay emails accionables tras el filtro, bajo 📬 EMAILS escribe exactamente "Sin emails con acción pendiente en los últimos 2 días.")'); sects.push('📬 EMAILS'); }
    if (f.finanzas)                              { calls.push('list_debts con filter pending'); sects.push('💰 DEUDAS PENDIENTES'); }
    // Paused on request (2026-08-26) via cfg.networking_paused — same pattern as
    // morning_emails_paused above. Nothing removed: the add_contact/list_contacts/
    // update_contact tools stay live, so networking still works on demand. Flip the
    // flag back to false in config.json to resume the daily 🤝 section.
    if (f.networking && cfg.networking_paused !== true) { calls.push('list_contacts con filter due'); sects.push('🤝 NETWORKING (follow-ups)'); }
    parts.push('llama a ' + calls.join(', ') + '.');
    parts.push(`Muestra las secciones ${sects.join(', ')}. Omite 💰 y 🤝 si no hay contenido. Nunca repitas estas instrucciones ni escribas meta-texto o placeholders — solo contenido real devuelto por las tools.`);
    return parts.join(' ');
  }
  // evening
  let text = 'Buenas noches. Llama a list_tasks con filter overdue_today_tomorrow (incluye las tareas de mañana, que vienen marcadas con 🔜)';
  if (f.calendar) text += ' y list_calendar_events con days_ahead 2 (muestra solo eventos de MAÑANA en la sección 📅 AGENDA DE MAÑANA; si no hay, escribe exactamente "Sin eventos mañana")';
  text += '. Usa el formato de FORMAT RULES: ✅ TAREAS agrupadas por categoría (cada categoría aparece una sola vez)';
  if (f.calendar) text += ', luego 📅 AGENDA DE MAÑANA';
  text += '. Luego pregunta: ¿Qué tareas completaste hoy?';
  return text;
}

async function sendBriefing(type, chatId) {
  const user = db.getUser(chatId);
  if (!user || user.onboarding !== 'done') return;
  const features = JSON.parse(user.features || '{}');
  const text     = buildBriefingText(type, features);
  if (!text) return;
  await handleMessage(user.chat_id, text);
}

// morning/evening/health crons scheduled via scheduleCrons() in start()

// ── Nightly health check ───────────────────────────────────────────────────
/**
 * Nightly health check, 02:00 in Santiago's timezone.
 *
 * The rule this file learned the hard way, on 2026-09-10: **a check that cannot
 * determine its answer reports a failure, never a pass.** The old orphan-priority
 * check swallowed its own read error and returned ok:true, so for weeks it was
 * green without ever having looked at anything.
 *
 * Every task call carries X-Telegram-Chat-Id. Since 2026-09-06 the API resolves
 * a bot request through the chat it names and refuses one that names nobody —
 * there is no owner fallback any more. A call without the header is a 401, which
 * is exactly how this check broke.
 */
async function runHealthCheck() {
  const results = [];
  const add = (ok, name, detail) => results.push({ ok, name, detail });

  const taskApi = (chatId) => fetch(`${cfg.task_api_base}/api/tasks`, {
    headers: {
      Authorization: `Bearer ${cfg.task_api_secret}`,
      'X-Telegram-Chat-Id': String(chatId)
    }
  });

  // 1. Telegram API
  try {
    const r = await tgRequest('getMe', {});
    add(!!r.ok, 'Telegram API', r.ok ? undefined : JSON.stringify(r));
  } catch (e) { add(false, 'Telegram API', e.message); }

  // 2. Task API — per user, because that is how it is actually used.
  //    A single anonymous ping cannot see the failure that matters now: one
  //    person's chat losing its link while everyone else's keeps working.
  const users = db.getDoneUsers();
  const tasksByUser = new Map();
  if (users.length === 0) {
    add(false, 'Task API', 'no onboarded users — nothing could be checked');
  } else {
    const broken = [];
    let unauthorized = 0;
    for (const u of users) {
      const who = u.preferred_name || u.name || u.chat_id;
      try {
        const r = await taskApi(u.chat_id);
        if (!r.ok) {
          if (r.status === 401) unauthorized++;
          broken.push(`${who}: HTTP ${r.status}`);
          continue;
        }
        const data = await r.json();
        tasksByUser.set(u.chat_id, data.tasks || []);
      } catch (e) { broken.push(`${who}: ${e.message}`); }
    }
    // A 401 means one of two very different things, and guessing wrong sends
    // whoever reads this alert after the wrong problem. The secret is shared by
    // every user: if all of them are refused it is the token, and if only some
    // are, those chats have lost their account link.
    let detail;
    if (broken.length === 0) detail = `${users.length} usuario(s) OK`;
    else if (unauthorized === users.length) detail = `401 para todos — revisa task_api_secret`;
    else detail = broken.join('; ') + (unauthorized ? ' — 401 = ese chat no tiene cuenta vinculada' : '');
    add(broken.length === 0, 'Task API', detail);
  }

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
      add(!!j.access_token, label, j.access_token ? undefined : (j.error || JSON.stringify(j)));
    } catch (e) { add(false, label, e.message); }
  }

  // 5. MCP processes still alive
  const mcpAlive = taskServer?.exitCode === null && calendarServer?.exitCode === null && sheetsServer?.exitCode === null;
  add(mcpAlive, 'MCP servers', mcpAlive ? undefined :
      `tasks exitCode=${taskServer?.exitCode} cal exitCode=${calendarServer?.exitCode} sheets exitCode=${sheetsServer?.exitCode}`);

  // 6. Status integrity — a status no filter recognizes makes the task vanish
  //    from every view without deleting it.
  //    ⚠️ Keep this list in step with STATUS_FINAL_OUTCOME_OPTIONS in the
  //    dashboard (src/lib/types.ts). "On-going" was missing here until
  //    2026-09-10, so the edit dialog could set a perfectly valid status that
  //    this check would then report as corruption.
  const VALID_STATUS = new Set(['to-do', 'on-going', 'done', 'on hold', '']);
  if (tasksByUser.size === 0) {
    add(false, 'Task DB — status integrity', 'no se pudo leer ninguna lista de tareas');
  } else {
    const bad = [];
    for (const [chatId, tasks] of tasksByUser) {
      for (const t of tasks) {
        const status = String(t.statusFinalOutcome || '').toLowerCase();
        if (!VALID_STATUS.has(status)) bad.push(`#${t.rowId} "${t.statusFinalOutcome}" (chat ${chatId})`);
      }
    }
    add(bad.length === 0, 'Task DB — status integrity',
        bad.length === 0 ? undefined : `${bad.length} tarea(s) con estado desconocido: ${bad.slice(0, 8).join(', ')}`);
  }

  // 7. Preference mirror — the failure mode introduced on 2026-09-06.
  //    Preferences live in Postgres and melissa.db is a mirror. If the sync
  //    fails quietly the bot keeps running on stale values: briefs fire at the
  //    old hour, categories drift, and nothing else in the system notices.
  try {
    const drift = [];
    for (const u of users) {
      const who = u.preferred_name || u.name || u.chat_id;
      try {
        const remote = prefs.toMirror(await prefs.fetchRemote(cfg, u.chat_id));
        const local = db.getUser(u.chat_id) || {};
        const off = Object.keys(remote).filter(k => String(local[k] ?? '') !== String(remote[k]));
        if (off.length) drift.push(`${who}: ${off.join(', ')}`);
      } catch (e) { drift.push(`${who}: no se pudo comparar (${e.message})`); }
    }
    add(drift.length === 0, 'Preferencias — espejo sincronizado',
        drift.length === 0 ? `${users.length} usuario(s) al día` : drift.join('; '));
  } catch (e) {
    add(false, 'Preferencias — espejo sincronizado', e.message);
  }

  // Retired 2026-09-10, both for measuring something that can no longer happen:
  //
  //   "missing due dates" — tasks.due_date_next_step is NOT NULL in Postgres and
  //   holds zero nulls, so the check could never fire. The concern it encoded
  //   (a task invisible to every date filter) is also gone: the redesigned
  //   dashboard has a "Sin fecha" section.
  //
  //   "priority flags" — priority moved into tasks.is_priority on 2026-09-01 and
  //   priorityMapFrom() replaced the file on every live path. The file it read
  //   is a frozen snapshot from 2026-08-28; comparing it against live tasks
  //   would alarm about flags nothing reads.

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
async function downloadFile(url, destPath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const fail = err => { file.destroy(); fs.unlink(destPath, () => {}); reject(err); };
    const req = proto.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return fail(new Error(`download HTTP ${res.statusCode}`)); }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', fail);
    });
    // Same reasoning as tgRequest: no default socket timeout means a stalled
    // download hangs the chat's queue forever. Partial temp file is cleaned up.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`download timed out after ${timeoutMs}ms`)));
    req.on('error', fail);
  });
}

// Domain vocabulary for Whisper. Without it, Spanish audio reliably joins "con
// vencimiento" (= "due on") into "Convencimiento".
//
// Currently UNUSED. It was briefly wired into transcribeVoice on 2026-08-25 and
// reverted the same night, when the bot stopped answering voice notes minutes after
// the deploy. That revert was a false alarm: the prompt param was later measured
// against the real API from this VM (3/3 calls under 2s, correct transcription), and
// a local-listener test showed the accented field encodes fine. The actual stall was
// in the Telegram legs of the voice path (getFile returned 504 Gateway Timeout), and
// neither tgRequest nor downloadFile has a timeout, so a stalled Telegram request
// wedges that chat's FIFO queue indefinitely. Safe to re-enable once those have
// timeouts; see [voice] handling in the polling loop.
// eslint-disable-next-line no-unused-vars
const VOICE_PROMPT_ES =
  'Notas sobre tareas, agenda y recordatorios. Vocabulario frecuente: con vencimiento ' +
  'mañana, con vencimiento el viernes, fecha de vencimiento, próximo paso, prioridad, ' +
  'pendientes, Ayudantías, bicursos, quizzes, Personal Finance, Berkeley, Whistler, ' +
  'profesor Robb, networking, follow-up, deuda, calendario.';

async function transcribeVoice(fileId, language) {
  // Step 1: get file path from Telegram
  const fileInfo = await tgRequest('getFile', { file_id: fileId });
  if (!fileInfo.ok) throw new Error('getFile failed: ' + JSON.stringify(fileInfo));
  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${cfg.telegram_token}/${filePath}`;

  // Step 2: download to temp file
  const tmpPath = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
  await downloadFile(fileUrl, tmpPath);

  // Step 3: transcribe with Whisper. The SDK has no per-call deadline of its own,
  // so it gets an AbortSignal for the same queue-wedging reason as the two above.
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), 60000);
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      // No language hint → Whisper autodetects (users who haven't picked one yet).
      ...(language ? { language } : {}),
    }, { signal: ac.signal });
    return transcription.text;
  } finally {
    clearTimeout(killer);
    fs.unlink(tmpPath, () => {});
  }
}

// ── Long polling loop ─────────────────────────────────────────────────────────
let offset = 0;
const processing = new Set(); // deduplicate concurrent messages
const chatQueues = new Map(); // per-chat FIFO queue — sequential processing per user

async function poll() {
  try {
    // 30s of long-polling on Telegram's side + 15s of slack before we give up.
    const res = await tgRequest('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, 45000);
    if (!res.ok || !res.result?.length) return;

    for (const update of res.result) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!message) continue;

      const chatId   = message.chat.id;
      const fromName = message.from?.first_name || 'user';
      let text       = message.text || '';

      // ── Handle voice messages — transcribe with Whisper ──────────────────
      const voiceFileId = message.voice?.file_id || message.audio?.file_id;
      if (voiceFileId && !text) {
        try {
          console.log(`[voice] transcribing from ${fromName}...`);
          const vUser = db.getUser(chatId);
          text = await transcribeVoice(voiceFileId, vUser ? vUser.language : null);
          console.log(`[voice→text] ${text.slice(0, 100)}`);
        } catch (err) {
          console.error('[voice error]', err.message);
          await sendMessage(chatId, '❌ No pude transcribir el audio. Intenta de nuevo.');
          continue;
        }
      }

      if (!text?.trim()) continue;

      // ── Admin: /invite command (Santiago only) ────────────────────────────
      if (chatId === cfg.telegram_chat_id && text.startsWith('/invite ')) {
        const parts = text.slice(8).trim().split(/\s+/);
        const label = parts[0];
        const email = parts[1] && parts[1].includes('@') ? parts[1] : null;
        if (!label) { await sendMessage(chatId, 'Uso: /invite <Nombre> [email@ejemplo.com]'); continue; }
        const code = db.createInviteCode(label, chatId, email);
        const link = `https://t.me/${botUsername || 'Melizion_bot'}?start=${code}`;
        let reply   = `✅ Código generado para ${label}:\n<code>${link}</code>\nVálido por 30 días.`;
        if (email) {
          try {
            await sendInviteEmail(email, label, link);
            reply += `\n📧 Invitación enviada a ${email}.`;
          } catch (e) {
            reply += `\n⚠️ No pude enviar el email: ${e.message}`;
          }
        }
        await sendMessage(chatId, reply);
        continue;
      }

      // ── Admin: user management commands (Santiago only) ───────────────────
      if (chatId === cfg.telegram_chat_id && /^\/(users|resetuser|deleteuser)\b/.test(text)) {
        await handleAdminCommand(chatId, text).catch(err => console.error('[admin]', err.message));
        continue;
      }

      // A t.me/<bot>?start=link_ABC12345 deep link arrives as "/start link_ABC…".
      // Rewriting it here means the web can offer one tappable link instead of
      // asking someone to copy a code into a chat, and both paths share the
      // same handler below.
      if (/^\/start\s+link_/i.test(text)) {
        text = '/link ' + text.replace(/^\/start\s+link_/i, '').trim();
      }

      // ── Connect a web account: /link CODE ────────────────────────────────
      // Handled before the authorization check on purpose: whoever sends this
      // has an account on the web but does not exist to the bot yet, which is
      // exactly what the command is for.
      if (/^\/link\b/i.test(text)) {
        const code = text.replace(/^\/link\b/i, '').trim().toUpperCase();
        if (!code) {
          await sendMessage(chatId, 'Para conectar tu cuenta, abre el dashboard en tu navegador, entra a *Ajustes → Telegram* y escribe aquí el código que te muestra:\n\n<code>/link TUCODIGO</code>');
          continue;
        }
        // Same brute-force throttle as invite codes: both are short secrets.
        if (inviteThrottled(chatId)) { continue; }
        try {
          const res = await fetch(`${cfg.task_api_base}/api/telegram/redeem`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.task_api_secret}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, chatId: String(chatId) }),
          });
          const data = await res.json().catch(() => ({}));

          if (!data.ok) {
            recordInviteFail(chatId);
            const why = {
              not_found:  'Ese código no existe. Genera uno nuevo desde Ajustes → Telegram en el dashboard.',
              expired:    'Ese código ya venció — duran 24 horas. Genera uno nuevo desde el dashboard.',
              used:       'Ese código ya se usó. Genera uno nuevo desde el dashboard.',
              chat_taken: 'Este Telegram ya está conectado a otra cuenta. Desconéctalo primero desde esa cuenta.',
            }[data.reason] || 'No pude conectar la cuenta. Intenta de nuevo en un momento.';
            await sendMessage(chatId, `❌ ${why}`);
            continue;
          }

          // The web half is linked. Now give them a bot-side record so the chat
          // is authorized, and run the normal onboarding to collect the things
          // only the bot needs: language, timezone and brief times.
          const existing = db.getUser(chatId);
          if (!existing) {
            db.createUser(chatId, { name: data.user.name || 'Amigo', features: { tasks: true, finanzas: true } });
            console.log(`[link] ${fromName} (${chatId}) → ${data.user.email}`);
            await sendMessage(chatId, `✅ Listo, quedaste conectado como *${data.user.name || data.user.email}*.\n\nTus tareas son las mismas aquí y en el dashboard. Ahora unas preguntas rápidas para dejarte configurado 👇`);
            await handleOnboarding(chatId, db.getUser(chatId), '');
          } else {
            console.log(`[link] ${fromName} (${chatId}) re-linked → ${data.user.email}`);
            await sendMessage(chatId, `✅ Conectado como *${data.user.name || data.user.email}*. Tus tareas son las mismas aquí y en el dashboard.`);
          }
        } catch (err) {
          console.error('[link error]', err.message);
          await sendMessage(chatId, '❌ No pude hablar con el dashboard ahora mismo. Intenta de nuevo en un minuto.');
        }
        continue;
      }

      // ── Invite claim: /start CODE ─────────────────────────────────────────
      if (text.startsWith('/start ')) {
        const code  = text.slice(7).trim();
        // F3: during a brute-force cooldown, silently ignore claim attempts.
        if (code && inviteThrottled(chatId)) { continue; }
        const label = code ? db.claimInviteCode(code, chatId) : null;
        if (code && label !== null) {
          // New users get Tasks + Finanzas only (email/calendar/networking stay Santiago-only)
          db.createUser(chatId, { name: label, features: { tasks: true, finanzas: true } });
          console.log(`[invite] ${fromName} (${chatId}) claimed code ${code} for "${label}"`);
          await handleOnboarding(chatId, db.getUser(chatId), '');
        } else if (code) {
          recordInviteFail(chatId); // F3
          await sendMessage(chatId, '❌ Ese código no es válido o ya fue usado. Pide a quien te invitó un nuevo link.');
        }
        // If no code (plain /start), fall through to authorization check
        if (code) continue;
      }

      // ── Authorization: only registered users ──────────────────────────────
      const user = db.getUser(chatId);
      if (!user) {
        console.log(`[ignored] unregistered: ${chatId}`);
        continue;
      }

      // ── Deduplicate ───────────────────────────────────────────────────────
      const key = `${chatId}:${message.message_id}`;
      if (processing.has(key)) continue;
      processing.add(key);

      console.log(`[in] ${fromName}: ${text.slice(0, 100)}`);
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

// ── Self-check (B1) ─────────────────────────────────────────────────────────
// Non-polling validation of a deployment. Prints a PASS/FAIL report and exits.
async function selfCheck() {
  const results = [];
  const add = (ok, name, detail) => results.push({ ok, name, detail });

  try {
    const u = cfg.telegram_chat_id ? db.getUser(cfg.telegram_chat_id) : null;
    add(true, `SQLite DB (${process.env.DB_PATH || 'default path'})`, u ? 'seeded user present' : 'opened');
  } catch (e) { add(false, 'SQLite DB', e.message); }

  try { fs.appendFileSync(USAGE_LOG, ''); add(true, `Usage log writable`, USAGE_LOG); }
  catch (e) { add(false, 'Usage log writable', `${USAGE_LOG}: ${e.message}`); }

  add(!!botUsername, 'Telegram getMe', botUsername ? `@${botUsername}` : 'no username returned');

  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.google_client_id, client_secret: cfg.google_client_secret,
        refresh_token: cfg.google_refresh_token, grant_type: 'refresh_token' }) });
    const j = await r.json();
    add(!!j.access_token, 'Google OAuth refresh (personal)', j.access_token ? 'ok' : (j.error || 'no token'));
  } catch (e) { add(false, 'Google OAuth refresh (personal)', e.message); }

  const mcpAlive = taskServer?.exitCode === null && calendarServer?.exitCode === null && sheetsServer?.exitCode === null;
  add(mcpAlive, 'MCP servers alive',
    mcpAlive ? 'tasks/calendar/sheets up' : `tasks=${taskServer?.exitCode} cal=${calendarServer?.exitCode} sheets=${sheetsServer?.exitCode}`);

  try {
    await callMCP(taskServer, taskPending, 'list_tasks', { filter: 'today' });
    add(true, 'MCP tasks responds', 'ok');
  } catch (e) { add(false, 'MCP tasks responds', e.message); }

  const failed = results.filter(r => !r.ok);
  console.log('\n=== SELFCHECK REPORT ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`=== ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'} ===\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  // ── SQLite: create tables + seed Santiago's user record ──────────────────
  db.migrate();
  if (cfg.telegram_chat_id) {
    db.createUser(cfg.telegram_chat_id, {
      name:           'Santiago',
      preferred_name: 'Santiago',
      onboarding:     'done',
      timezone:       cfg.timezone || 'America/Los_Angeles',
      features: {
        tasks: true, finanzas: true, email: true, calendar: true, networking: true,
      },
    });
  }

  const SKILLS_DIR = process.env.SKILLS_DIR || '/root/.openclaw/skills';
  taskServer = startMCPServer(`${SKILLS_DIR}/tasks-mcp.js`,
    // OPENAI_MODEL lets get_usage price the report against the model actually in
    // use instead of a hardcoded gpt-4.1-mini rate.
    { TASK_API_BASE: cfg.task_api_base, TASK_API_SECRET: cfg.task_api_secret,
      OPENAI_MODEL: cfg.openai_model },
    taskPending, 'tasks');
  calendarServer = startMCPServer(`${SKILLS_DIR}/calendar-mcp.js`,
    { GOOGLE_CLIENT_ID: cfg.google_client_id, GOOGLE_CLIENT_SECRET: cfg.google_client_secret,
      GOOGLE_REFRESH_TOKEN: cfg.google_refresh_token, GOOGLE_REFRESH_TOKEN_BERKELEY: cfg.google_refresh_token_berkeley,
      TIMEZONE: cfg.timezone || 'America/Los_Angeles' },
    calPending, 'calendar');
  sheetsServer = startMCPServer(`${SKILLS_DIR}/sheets-mcp.js`,
    { GOOGLE_CLIENT_ID: cfg.google_client_id, GOOGLE_CLIENT_SECRET: cfg.google_client_secret,
      GOOGLE_REFRESH_TOKEN_BERKELEY: cfg.google_refresh_token_berkeley,
      NETWORK_SHEET_ID: cfg.network_sheet_id,
      TIMEZONE: cfg.timezone || 'America/Los_Angeles' },
    sheetsPending, 'sheets');

  await fetchBotInfo();

  // B1: self-check mode — validate the runtime (DB, MCP, OAuth, file access,
  // Telegram) WITHOUT starting the Telegram poll loop, so a new (e.g. non-root)
  // deployment can be verified while the live service keeps polling. No cutover
  // risk: SELFCHECK never consumes updates. Exits 0 (all pass) or 1 (any fail).
  if (process.env.SELFCHECK === '1') {
    await new Promise(r => setTimeout(r, 2000)); // let MCP children initialize
    return selfCheck();
  }

  console.log('✅ Bot started — polling Telegram (no webhook needed)');
  console.log('   Send any message to @Melizion_bot on Telegram');

  // Preferences live in Postgres; SQLite is a mirror. Refresh it before the
  // brief crons are built out of it, or the first day after a change on the web
  // still fires at the old hour. Failures are logged and tolerated — the mirror
  // is what makes an unreachable dashboard a staleness problem instead of an
  // outage.
  try {
    const moved = await prefs.pullAll(cfg);
    console.log(`[prefs] mirror refreshed (${moved} user(s) changed)`);
  } catch (err) {
    console.log(`[prefs] initial sync failed, using the local mirror: ${err.message}`);
  }

  scheduleCrons();
  prefs.startBackgroundSync(cfg, scheduleCrons);
  // timezone auto-detect disabled (Calendar API returns stale value)
  // use update_timezone tool or tell Melissa you are in a different city

  pollLoop(); // fire and forget — runs forever
}

start().catch(err => { console.error('Fatal:', err); process.exit(1); });
