#!/usr/bin/env node
/**
 * MCP server that exposes Santiago's task dashboard API as agent tools.
 * Communicates over stdio using JSON-RPC (MCP protocol).
 */

const fs = require("fs");
const { AsyncLocalStorage } = require("node:async_hooks");

// Which Telegram user the current tool call is acting for. Scoped per call
// rather than kept in a module-level variable, so two users' calls cannot
// interleave and read each other's id.
const callCtx = new AsyncLocalStorage();
const CATS_PATH = process.env.CATS_PATH || '/root/whatsapp-bot/categories.json';
function loadCategories() {
  try { return JSON.parse(fs.readFileSync(CATS_PATH, 'utf8')); }
  catch { return [
    {name:"Ayudantias",keywords:["ayudantía","ayudante"]},
    {name:"Clases",keywords:["clase","tarea","prueba","examen"]},
    {name:"Finanzas",keywords:["pagar","banco","zelle","tarjeta"]},
    {name:"Golf club",keywords:["golf","club","tee"]},
    {name:"Otros",keywords:[]},
    {name:"Recruiting",keywords:["postular","entrevista","cv"]},
    {name:"S3",keywords:["S3","startup"]},
    {name:"University",keywords:["berkeley","GSB","campus"]}
  ]; }
}
const CATEGORIES = loadCategories();
const CATEGORY_NAMES = CATEGORIES.map(c => c.name);


const BASE_URL = process.env.TASK_API_BASE || "http://localhost:3000";
// No hardcoded fallback: the secret is always supplied via env by the bot at
// spawn time, and an in-source default is a credential leak to anyone who can
// read the file. Fail loudly instead of silently running with a stale key.
const SECRET   = process.env.TASK_API_SECRET;
if (!SECRET) {
  console.error("tasks-mcp: TASK_API_SECRET is not set — refusing to start.");
  process.exit(1);
}

const HEADERS = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${SECRET}`
};

// ── Priority store (local file, keyed by rowId string) ────────────────────────

const PRIORITY_FILE = process.env.PRIORITY_FILE || "/root/.openclaw/priority.json";

// Priority moved into the task API on 2026-09-01 (tasks.is_priority). It used to
// live in PRIORITY_FILE, keyed by rowId, which the web dashboard could not see —
// the bot and the web disagreed about what was urgent. Build the same
// { rowId: true } shape the call sites expect, but from the API's own answer, so
// there is one source of truth. loadPriority/savePriority are kept only for the
// one-time migration and are no longer read on any live path.
function priorityMapFrom(tasks) {
  const out = {};
  for (const t of tasks || []) if (t && t.isPriority === true) out[String(t.rowId)] = true;
  return out;
}

function loadPriority() {
  try { return JSON.parse(fs.readFileSync(PRIORITY_FILE, "utf8")); }
  catch { return {}; }
}

function savePriority(p) {
  fs.writeFileSync(PRIORITY_FILE, JSON.stringify(p, null, 2));
}

// ── Usage tracking ────────────────────────────────────────────────────────────

const USAGE_DIR = process.env.USAGE_DIR || "/root/.openclaw/usage";
const USAGE_LOG = USAGE_DIR + "/usage-log.jsonl";

function estimateTokens(str) { return Math.ceil((str || "").length / 4); }

function logUsage(toolName, inputStr, outputStr) {
  try {
    if (!fs.existsSync(USAGE_DIR)) fs.mkdirSync(USAGE_DIR, { recursive: true });
    const entry = { ts: new Date().toISOString(), tool: toolName, input: estimateTokens(inputStr), output: estimateTokens(outputStr) };
    fs.appendFileSync(USAGE_LOG, JSON.stringify(entry) + "\n");
  } catch {}
}

function readUsageForMonth(month) {
  if (!month) month = new Date().toISOString().slice(0, 7);
  let inputTok = 0, outputTok = 0, calls = 0;
  try {
    const lines = fs.readFileSync(USAGE_LOG, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.ts && e.ts.startsWith(month)) { inputTok += e.input || 0; outputTok += e.output || 0; calls++; }
      } catch {}
    }
  } catch {}
  return { month, inputTok, outputTok, calls };
}

// ── API helper ────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const url  = `${BASE_URL}${path}`;
  const chatId = callCtx.getStore() && callCtx.getStore().chatId;
  const opts = {
    ...options,
    headers: {
      ...HEADERS,
      ...(chatId ? { "X-Telegram-Chat-Id": String(chatId) } : {}),
      ...(options.headers || {}),
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res  = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { error: text }; }
      // A non-2xx MUST surface as an error even when the body has no `error`
      // key. Without this, a 5xx/403 whose JSON happens to lack `error` was
      // counted as a successful write and reported to the user as "✅".
      if (!res.ok) {
        return { error: body && body.error ? body.error : `HTTP ${res.status}`, status: res.status };
      }
      return body;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 0) continue;
      throw err;
    }
  }
}

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_tasks",
    description: "List tasks with filter. Returns task names, due dates, priority flags, and [#N] IDs for internal use.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["overdue_and_today", "overdue_today_tomorrow", "today", "tomorrow", "this_week", "overdue", "on_hold"],
          description: "Which tasks to show. DEFAULT (omit filter): overdue_and_today. Use 'overdue_today_tomorrow' for the EVENING brief (adds tomorrow's tasks, marked 🔜). Use 'this_week' for the week ahead. Use 'overdue_and_today' whenever user asks for 'mis tareas', 'my tasks', 'tareas pendientes', or similar with no time qualifier. NEVER invent a filter not in the enum."
        },
        section: {
          type: "string",
          description: "Optional section header. Replaces default header."
        }
      }
    }
  },
  {
    name: "add_task",
    description: "Add a new task. Set isPriority=true for urgent tasks.",
    inputSchema: {
      type: "object",
      required: ["toDo", "dueDateNextStep"],
      properties: {
        toDo:              { type: "string", description: "Task description" },
        dueDateNextStep:   { type: "string", description: "Due date in YYYY-MM-DD format" },
        tipo:              { type: "string", enum: CATEGORY_NAMES, description: "Infer from context. See system prompt for rules." },
        nextStep:          { type: "string", description: "Next action" },
        isPriority:        { type: "boolean", description: "true = urgent/importante/asap" },
        recurrenceInterval:{ type: "number", description: "Repeat every N units (optional)" },
        recurrenceUnit:    { type: "string", enum: ["day","week","month"], description: "Recurrence unit (optional)" }
      }
    }
  },
  {
    name: "update_task",
    description: "Update a task by ID.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId:             { type: "number", description: "The task's rowId" },
        toDo:               { type: "string" },
        dueDateNextStep:    { type: "string", description: "YYYY-MM-DD" },
        tipo:               { type: "string", enum: CATEGORY_NAMES },
        nextStep:           { type: "string" },
        statusFinalOutcome: { type: "string", enum: ["To-do","Done"], description: "Use delete_task instead of setting Cancelled when user wants to remove a task" },
        isPriority:         { type: "boolean", description: "Set true to mark as priority (🔴), false to remove priority flag." },
        recurrenceInterval: { type: "number" },
        recurrenceUnit:     { type: "string", enum: ["day","week","month"] }
      }
    }
  },
  {
    name: "get_usage",
    description: "Show estimated OpenAI token usage and cost for a given month. Use when user asks: cu\u00e1nto hemos gastado, uso de tokens, costo de mayo, reporte de OpenAI, cu\u00e1nto cost\u00f3 el mes, how much have we spent, monthly cost.",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "Month to query in YYYY-MM format, e.g. \"2026-05\". Default: current month." }
      }
    }
  },
  {
    name: "delete_task",
    description: "Permanently delete a task. Always call list_tasks first to get the taskId. Irreversible.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "number", description: "The task's rowId" }
      }
    }
  },
  {
    name: "update_tasks",
    description: "Update MULTIPLE tasks in one call (runs in parallel). Use this instead of calling update_task in a loop. When user marks several tasks done at once, always use this.",
    inputSchema: {
      type: "object",
      required: ["updates"],
      properties: {
        updates: {
          type: "array",
          description: "Array of task updates. Each item must have taskId plus the fields to update.",
          items: {
            type: "object",
            required: ["taskId"],
            properties: {
              taskId:             { type: "number", description: "The task rowId from [#N] in the list" },
              statusFinalOutcome: { type: "string", enum: ["To-do","Done"] },
              dueDateNextStep:    { type: "string", description: "YYYY-MM-DD" },
              toDo:               { type: "string" },
              tipo:               { type: "string", enum: CATEGORY_NAMES },
              isPriority:         { type: "boolean" }
            }
          }
        }
      }
    }
  }
  ,
  {
    name: "add_category",
    description: "Permanently add a new task category. Call when user says \"agrega la categoría\" or \"crea una categoría\". Infer 3-5 obvious Spanish keywords from the category name — do NOT ask the user for keywords.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name:     { type: "string", description: "Category display name (e.g. \"Viajes\")" },
        keywords: { type: "array", items: { type: "string" }, description: "3-5 obvious Spanish keywords inferred from the name" }
      }
    }
  }
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

function todayISO() { return new Intl.DateTimeFormat("en-CA", {timeZone: "America/Los_Angeles"}).format(new Date()); }
function tomorrowISO() { const d = new Date(); d.setDate(d.getDate()+1); return new Intl.DateTimeFormat("en-CA", {timeZone: "America/Los_Angeles"}).format(d); }
function weekEndISO() { const d = new Date(); d.setDate(d.getDate()+7); return new Intl.DateTimeFormat("en-CA", {timeZone: "America/Los_Angeles"}).format(d); }

// Normalize any status synonym to its canonical English value before writing to the API.
// Defensive layer: if the LLM sends a Spanish or non-standard variant, this fixes it
// at the source so the DB stays consistent and all filters work correctly.
function normalizeStatus(status) {
  if (!status) return status;
  const s = status.toLowerCase().trim();
  const doneWords   = ["done","listo","lista","realizado","realizada","completed","hecho","hecha","ready","ok","terminado","terminada","tachado","marcado"];
  const onHoldWords = ["on hold","en pausa","pausa","pausado","pausada","suspendido","suspendida","hold","en espera","espera"];
  if (doneWords.includes(s))   return "Done";
  if (onHoldWords.includes(s)) return "On hold";
  return status; // "To-do" and anything else passes through unchanged
}

function fmtDate(dateStr) {
  if (!dateStr) return null;
  // D-MMM, e.g. "3-Mar". The year is appended only when it is not the current
  // one ("3-Mar-2027"), so ordinary dates stay short and never ambiguous.
  const months = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const [y, m, d] = dateStr.split("-");
  const curYear = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }).slice(0, 4);
  const base = `${parseInt(d)}-${months[parseInt(m)-1]}`;
  return y === curYear ? base : `${base}-${y}`;
}

async function list_tasks({ filter = "overdue_and_today", section = null } = {}) {
  const data = await apiFetch("/api/tasks");
  if (data.error) return data.error;
  let tasks = data.tasks || [];

  // on_hold filter: return only on-hold tasks; all other filters exclude them
  if (filter === "on_hold") {
    tasks = tasks.filter(t => (t.statusFinalOutcome || "").toLowerCase() === "on hold");
  } else {
    tasks = tasks.filter(t => (t.statusFinalOutcome || "").toLowerCase() !== "on hold");
  }

  const today = todayISO();
  const tomorrow = tomorrowISO();
  const weekEnd = weekEndISO();

  const notDone = t => (t.statusFinalOutcome || "").toLowerCase() !== "done";

  // Special combined filter for cron briefings
  if (filter === "overdue_and_today") {
    const overdueTasks = tasks.filter(t => t.dueDateNextStep < today && notDone(t));
    const todayTasks   = tasks.filter(t => t.dueDateNextStep === today && notDone(t));
    const priority = priorityMapFrom(tasks);
    const sortFn = (a, b) => {
      const ap = priority[String(a.rowId)] ? 0 : 1, bp = priority[String(b.rowId)] ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (a.dueDateNextStep || "").localeCompare(b.dueDateNextStep || "");
    };
    overdueTasks.sort(sortFn); todayTasks.sort(sortFn);
    const allTasks = [...overdueTasks, ...todayTasks];
    if (allTasks.length === 0) return "\u23f0 Vencidas: ninguna \u2705\n\uD83D\uDCC5 Para hoy: ninguna \u2705";
    const fmtSection = (arr, hdr, offset) => {
      if (arr.length === 0) return `${hdr}: ninguna \u2705`;
      const lines = arr.map((t, i) => {
        const date = fmtDate(t.dueDateNextStep);
        const flag = priority[String(t.rowId)] ? "\uD83D\uDD34 " : "";
        const cat = t.tipo ? `[${t.tipo}] ` : '';
        const id = `[#${t.rowId}]`;
        return date ? `${flag}${cat}${t.toDo} \u2014 ${date} ${id}` : `${flag}${cat}${t.toDo} ${id}`;
      });
      return `${hdr} (${arr.length}):\n${lines.join("\n")}`;
    };
    return (
      fmtSection(overdueTasks, "\u23f0 Vencidas", 0) + "\n\n" +
      fmtSection(todayTasks, "\uD83D\uDCC5 Para hoy", overdueTasks.length)
    );
  }

  // Evening brief: overdue + today + TOMORROW. Tomorrow lines get a "\uD83D\uDD1C " marker
  // (after any \uD83D\uDD34 priority flag) so the model renders them distinctly; today/overdue
  // lines are byte-for-byte identical to the overdue_and_today filter above.
  if (filter === "overdue_today_tomorrow") {
    const overdueTasks  = tasks.filter(t => t.dueDateNextStep < today && notDone(t));
    const todayTasks    = tasks.filter(t => t.dueDateNextStep === today && notDone(t));
    const tomorrowTasks = tasks.filter(t => t.dueDateNextStep === tomorrow && notDone(t));
    const priority = priorityMapFrom(tasks);
    const sortFn = (a, b) => {
      const ap = priority[String(a.rowId)] ? 0 : 1, bp = priority[String(b.rowId)] ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (a.dueDateNextStep || "").localeCompare(b.dueDateNextStep || "");
    };
    overdueTasks.sort(sortFn); todayTasks.sort(sortFn); tomorrowTasks.sort(sortFn);
    if (overdueTasks.length + todayTasks.length + tomorrowTasks.length === 0)
      return "\u23f0 Vencidas: ninguna \u2705\n\uD83D\uDCC5 Para hoy: ninguna \u2705\n\uD83D\uDD1C Ma\u00F1ana: ninguna \u2705";
    const fmtSection = (arr, hdr, marker = "") => {
      if (arr.length === 0) return `${hdr}: ninguna \u2705`;
      const lines = arr.map((t) => {
        const date = fmtDate(t.dueDateNextStep);
        const flag = priority[String(t.rowId)] ? "\uD83D\uDD34 " : "";
        const cat = t.tipo ? `[${t.tipo}] ` : '';
        const id = `[#${t.rowId}]`;
        return date ? `${flag}${marker}${cat}${t.toDo} \u2014 ${date} ${id}` : `${flag}${marker}${cat}${t.toDo} ${id}`;
      });
      return `${hdr} (${arr.length}):\n${lines.join("\n")}`;
    };
    return [
      fmtSection(overdueTasks, "\u23f0 Vencidas"),
      fmtSection(todayTasks, "\uD83D\uDCC5 Para hoy"),
      fmtSection(tomorrowTasks, "\uD83D\uDD1C Ma\u00F1ana", "\uD83D\uDD1C "),
    ].join("\n\n");
  }

  if (filter === "pending" || filter === "all") filter = "overdue_and_today"; // alias: redirect to default
  if (filter === "today")     tasks = tasks.filter(t => t.dueDateNextStep === today   && notDone(t));
  if (filter === "tomorrow")  tasks = tasks.filter(t => t.dueDateNextStep === tomorrow && notDone(t));
  if (filter === "this_week") tasks = tasks.filter(t => t.dueDateNextStep >= today && t.dueDateNextStep <= weekEnd && notDone(t));
  if (filter === "overdue")   tasks = tasks.filter(t => t.dueDateNextStep < today    && notDone(t));

  if (tasks.length === 0) {
    return section ? `${section}: ninguna \u2705` : "No hay tareas pendientes.";
  }

  // Sort: priority tasks first, then by date
  const priority = priorityMapFrom(tasks);
  tasks.sort((a, b) => {
    const ap = priority[String(a.rowId)] ? 0 : 1;
    const bp = priority[String(b.rowId)] ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (a.dueDateNextStep || "").localeCompare(b.dueDateNextStep || "");
  });

  const header = section ? `${section} (${tasks.length}):` : `\uD83D\uDCCB Tareas (${tasks.length}):`;

  const lines = tasks.map((t, i) => {
    const date = fmtDate(t.dueDateNextStep);
    const flag = priority[String(t.rowId)] ? "\uD83D\uDD34 " : "";
    const cat = t.tipo ? `[${t.tipo}] ` : '';
    const id = `[#${t.rowId}]`;
    return date ? `${flag}${cat}${t.toDo} \u2014 ${date} ${id}` : `${flag}${cat}${t.toDo} ${id}`;
  });
  return `${header}\n${lines.join("\n")}`;
}

async function add_task({ toDo, dueDateNextStep, tipo = "Otros", nextStep = "", isPriority = false, recurrenceInterval = null, recurrenceUnit = null }) {
  return apiFetch("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ toDo, dueDateNextStep, tipo, nextStep, statusFinalOutcome: "To-do", recurrenceInterval, recurrenceUnit, isPriority: isPriority === true })
  });
}

async function update_task({ taskId, isPriority, ...patch }) {
  // Priority is now a task field like any other, so it goes in the same PATCH.
  if (isPriority !== undefined) patch.isPriority = isPriority === true;
  // Normalize statusFinalOutcome to canonical "Done" regardless of what the LLM sent
  if (patch.statusFinalOutcome) patch.statusFinalOutcome = normalizeStatus(patch.statusFinalOutcome);
  // No task fields to write. Reporting a no-op as a successful update is how this
  // codebase has claimed work it never did before; say so instead.
  if (Object.keys(patch).length === 0) {
    return { error: "Sin campos que actualizar — no se cambió nada." };
  }
  return apiFetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ patch })
  });
}

async function delete_task({ taskId }) {
  // No priority cleanup needed: the flag is a column on the row being deleted.
  return apiFetch(`/api/tasks/${taskId}`, { method: "DELETE" });
}

// USD per 1M tokens. Keep in sync with cfg.openai_model, which is passed in as
// OPENAI_MODEL at spawn. For the gpt-5 family, reasoning tokens are billed as
// output tokens, so the output rate dominates more than the raw ratio suggests.
const PRICES = {
  "gpt-4.1-mini": { in: 0.40, out: 1.60 },
  "gpt-4.1":      { in: 2.00, out: 8.00 },
  "gpt-5-mini":   { in: 0.25, out: 2.00 },
  "gpt-5":        { in: 1.25, out: 10.00 },
};

async function get_usage({ month } = {}) {
  const data  = readUsageForMonth(month || null);
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const price = PRICES[model] || PRICES["gpt-5-mini"];
  const cost  = (data.inputTok / 1e6) * price.in + (data.outputTok / 1e6) * price.out;
  return (
    "\uD83D\uDCCA Uso " + data.month + " (" + model + "):\n" +
    "  Tokens entrada:  ~" + data.inputTok.toLocaleString() + "\n" +
    "  Tokens salida:   ~" + data.outputTok.toLocaleString() + "\n" +
    "  Costo estimado:  $" + cost.toFixed(4) + " USD\n" +
    "  Interacciones:   " + data.calls
  );
}

async function update_tasks({ updates = [] }) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return "❌ No se recibió ninguna tarea que actualizar — no se cambió nada.";
  }
  const results = await Promise.all(updates.map(async ({ taskId, isPriority, ...patch }) => {
    // Priority is a task field now, so it rides along in the same PATCH.
    if (isPriority !== undefined) patch.isPriority = isPriority === true;
    // Normalize statusFinalOutcome to canonical "Done"
    if (patch.statusFinalOutcome) patch.statusFinalOutcome = normalizeStatus(patch.statusFinalOutcome);
    if (Object.keys(patch).length === 0) {
      return { taskId, res: { error: "sin campos que actualizar" } };
    }
    try {
      const res = await apiFetch(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ patch }) });
      return { taskId, res };
    } catch (err) {
      // A thrown fetch (timeout/network) must not reject Promise.all and hide
      // the outcome of the sibling updates.
      return { taskId, res: { error: err.message } };
    }
  }));
  const bad = results.filter(r => !r.res || r.res.error);
  const ok  = results.length - bad.length;
  if (bad.length === 0) {
    return `✅ ${ok} tarea${ok !== 1 ? "s" : ""} actualizada${ok !== 1 ? "s" : ""}.`;
  }
  // Name the failures so the model cannot report a partial write as success.
  const detail = bad.map(b => `[#${b.taskId}]: ${(b.res && b.res.error) || "error desconocido"}`).join("; ");
  return ok === 0
    ? `❌ NINGUNA tarea se actualizó. Errores — ${detail}`
    : `⚠️ Solo ${ok} de ${results.length} se actualizaron. Fallaron — ${detail}`;
}

async function add_category({ name, keywords = [] }) {
  if (!name || !name.trim()) return '❌ Category name is required.';
  let cats;
  try { cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8')); }
  catch { cats = []; }
  const trimmed = name.trim();
  if (cats.some(c => c.name.toLowerCase() === trimmed.toLowerCase())) {
    return `❌ La categoría "${trimmed}" ya existe.`;
  }
  cats.push({ name: trimmed, keywords: keywords || [] });
  const tmp = CATS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cats, null, 2));
  fs.renameSync(tmp, CATS_PATH);
  return `✅ Categoría "${trimmed}" agregada. Ya está disponible en la próxima conversación.`;
}

const HANDLERS = { list_tasks, add_task, update_task, update_tasks, delete_task, get_usage, add_category };

// ── MCP JSON-RPC server over stdio ────────────────────────────────────────────

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "tasks-mcp", version: "1.0.0" }
    });
  }

  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const { name, arguments: rawArgs } = params;
    if (!HANDLERS[name]) return error(id, -32601, `Unknown tool: ${name}`);
    // _chatId is injected by the bot, never by the model. Strip it here so no
    // handler can pass it through into a request body or a task title.
    const { _chatId, ...args } = rawArgs || {};
    try {
      const result = await callCtx.run(
        { chatId: _chatId ? String(_chatId) : null },
        () => HANDLERS[name](args)
      );
      const text = typeof result === "string" ? result : JSON.stringify(result);
      logUsage(name, JSON.stringify(args), text);
      return reply(id, { content: [{ type: "text", text }] });
    } catch (err) {
      return error(id, -32603, err.message);
    }
  }

  if (method === "notifications/initialized") return; // no reply needed

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
