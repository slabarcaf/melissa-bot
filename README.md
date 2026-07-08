# Melissa — Personal AI Assistant (Telegram)

Melissa is a personal AI assistant that lives in Telegram. She manages tasks, calendar events, and email — and delivers morning/evening briefings automatically every day.

**Telegram handle:** configured via `TELEGRAM_TOKEN` in `.env`

---

## Features

- **Natural language task management** — add, update, complete, move, and delete tasks by chatting. Tasks are persisted in a hosted task dashboard. Every mutating action (mark done, move, delete) is **verified** with a follow-up `list_tasks` read before Melissa reports success — she never claims an action she didn't actually perform.
- **Dynamic task categories** — categories live in `categories.json` (not hardcoded). Create a new one on the fly by chatting — "agrega la categoría Viajes" — but only with your explicit confirmation, and Melissa first checks that a same/similar category doesn't already exist before creating it.
- **Google Calendar integration** — add events and get your daily agenda via natural language.
- **Gmail triage** — scans multiple Gmail accounts and surfaces only emails from real people that need a reply.
- **Voice messages** — transcribes voice notes via OpenAI Whisper, then processes them as text.
- **Morning briefing** (7 AM PT) — agenda, overdue/today tasks, and actionable emails in one formatted message.
- **Evening briefing** (8 PM PT) — today's remaining tasks, tomorrow's agenda, and a check-in on what got done.
- **Nightly health check** (2 AM PT) — verifies Telegram API, Task API, Google OAuth tokens, and MCP server processes. Sends an alert if anything is broken.
- **Bilingual** — responds in English or Spanish depending on how you write to her.

---

## Architecture

```
Telegram ──long-poll──▶ melissa.js ──▶ OpenAI GPT-4 (tool_choice: auto)
                                             │
                         ┌───────────────────┼───────────────────┐
                         ▼                   ▼                   ▼
                    tasks-mcp.js      calendar-mcp.js      Whisper API
                    (Task Dashboard)  (Google Calendar     (voice transcription)
                                       + Gmail)
```

- **`melissa.js`** — main bot loop. Handles Telegram long-polling, routes messages through GPT-4 with tool use, and manages conversation history per chat.
- **`tasks-mcp.js`** — MCP server wrapping the task dashboard REST API (list, add, update, delete tasks, and add categories). Loads the category list from `categories.json` at startup.
- **`categories.json`** — the source of truth for task categories and their inference keywords. Read by both `melissa.js` (to build the system prompt) and `tasks-mcp.js` (to validate task categories). Editable by hand or via the `add_category` tool.
- **`calendar-mcp.js`** — MCP server wrapping Google Calendar and Gmail APIs via OAuth.
- Both MCP servers are spawned as child processes and communicate over stdin/stdout (JSON-RPC). They auto-restart on crash.

---

## Setup

### Prerequisites

- Node.js 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenAI API key
- A Google Cloud project with Gmail + Calendar APIs enabled, and OAuth2 credentials
- The `tasks-mcp.js` and `calendar-mcp.js` MCP server scripts (separate repo)

### Install

```bash
git clone https://github.com/yourusername/melissa-bot.git
cd melissa-bot
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|---|---|
| `TELEGRAM_TOKEN` | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram user ID (auto-saved on first message if left blank) |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_MODEL` | Model to use (default: `gpt-4.1-mini`) |
| `TASK_API_BASE` | Base URL of the task dashboard API |
| `TASK_API_SECRET` | Bearer token for the task API |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Refresh token for primary Gmail/Calendar account |
| `GOOGLE_REFRESH_TOKEN_BERKELEY` | Refresh token for secondary Gmail/Calendar account |
| `TASKS_MCP_PATH` | Absolute path to `tasks-mcp.js` |
| `CALENDAR_MCP_PATH` | Absolute path to `calendar-mcp.js` |

### Run

```bash
npm start
```

---

## Production deployment (Oracle VM)

The bot runs as a `systemd` service on an Oracle Cloud VM.

```bash
# View logs
sudo journalctl -u whatsapp-bot -f

# Restart after changes
sudo systemctl restart whatsapp-bot

# Check status
sudo systemctl status whatsapp-bot
```

To deploy a code change, push to GitHub and run the deploy script on the server:

```bash
# From any machine with an authorized SSH key (~/.ssh/id_ed25519)
ssh -i ~/.ssh/id_ed25519 opc@<VM_IP> 'sudo /root/deploy-melissa.sh [branch]'   # default branch: pause-morning-brief
```

The script (`/root/deploy-melissa.sh` on the VM) pulls the branch via a read-only GitHub
deploy key (`/root/.ssh/github_deploy`), copies the files into place
(`melissa.js` → `/root/whatsapp-bot/whatsapp-bot.js`, `db.js`, `package.json`;
`sheets-mcp.js` → `/root/.openclaw/skills/`), runs `npm install`, and restarts the service.

Server facts worth remembering:
- The VM is Oracle Linux 8 — native npm modules that need glibc ≥ 2.29 or Python ≥ 3.8 **will not build**. SQLite is provided by Node 22's built-in `node:sqlite` for this reason (no `better-sqlite3`).
- `/root/whatsapp-bot/` is the runtime dir (not a git repo); the git checkout lives at `/root/melissa-bot/`.
- MCP servers (`tasks-mcp.js`, `calendar-mcp.js`, `sheets-mcp.js`) live in `/root/.openclaw/skills/`.
- SSH keys authorized for `opc`: Santiago's Mac and Windows PC (`windows-pc-melissa`).

> **Note:** The production VM uses `config.json` instead of `.env`. The code supports both — if `TELEGRAM_TOKEN` is set in the environment, it uses env vars; otherwise it falls back to `config.json`.

---

## Task categories

Categories are stored in **`categories.json`** as a list of `{ name, keywords }` objects — they are **not** hardcoded in the source. On startup, `tasks-mcp.js` loads them to validate the `tipo` of each task, and `melissa.js` injects them into the system prompt so GPT can infer the right category from context. When `add_task` is called, Melissa picks the category from the user's wording or infers it from these keywords.

Default categories:

| Category | Inference keywords |
|---|---|
| Ayudantias | ayudantía, ayudante |
| Clases | clase, tarea, prueba, examen |
| Finanzas | pagar, banco, zelle, tarjeta |
| Golf club | golf, club, tee |
| Otros | _(default — used when nothing else matches)_ |
| Recruiting | postular, entrevista, cv |
| S3 | S3, startup |
| University | berkeley, GSB, campus |

### Adding a category

You don't need to edit code. Just tell Melissa in chat:

> "agrega la categoría Viajes"

Melissa never creates a category on her own initiative — only when you explicitly ask. Before creating, she:

1. **Checks for an existing same/similar category** (matching across accents and casing — e.g. she will not create "Others" when "Otros" exists, or "golf" when "Golf club" exists). If one already exists, she tells you and asks if that's the one you meant instead of creating a duplicate.
2. **Asks for explicit confirmation** — "Voy a crear la categoría nueva [name] — ¿la creo?" — and waits for a yes.
3. Only then calls `add_category`, which infers 3–5 keywords from the name, appends `{ name, keywords }` to `categories.json` using an **atomic write** (temp file + rename) so the file can never be left corrupted, and rejects empty or duplicate names.

The new category is available in the **next conversation** (the MCP server reloads the list on restart; `melissa.js` reads it fresh on every message).

> **Category integrity:** when adding or moving a task, the `tipo` must match an existing category **exactly** (accents and casing included). Melissa is forbidden from inventing a new category name through `add_task` / `update_task`, which previously caused silent duplicates like `Others` vs `Otros` and `golf club` vs `Golf club`.

> **Note:** Categories are stored in their own file rather than in `config.json` on purpose — `config.json` holds API keys and tokens, so keeping category writes isolated means a bad write can never break the bot's credentials.

---

## Cron schedule

| Time (PT) | Job |
|---|---|
| 7:00 AM daily | Morning briefing |
| 8:00 PM daily | Evening briefing |
| 2:00 AM daily | Health check |

---

## Reliability guardrails

The system prompt enforces strict rules so Melissa cannot *say* she did something without actually doing it:

- **No hallucinated actions** — she may never report a task as marked done, moved, updated, or deleted unless the matching tool (`update_task` / `update_tasks` / `delete_task`) was actually called in that same turn. Describing an action in the future tense ("voy a moverla", "la elimino") without emitting the call is forbidden — she performs it now, then reports.
- **Mandatory post-action verification** — after every `update_task`, `update_tasks`, or `delete_task`, she immediately re-reads with `list_tasks` and confirms the change is reflected (moved to the new category, gone after a delete, new status). If it isn't, the operation **failed** and she says so rather than reporting a false success.
- **Category integrity** — task `tipo` values must match an existing category exactly; new categories require explicit user confirmation and a duplicate check (see [Adding a category](#adding-a-category)).

---

## Changelog

### 2026-06-18 — task-action reliability fix
- **Symptom:** Melissa would say "voy a moverla / la elimino" for a task but the change never landed — the move/delete was never executed (the `gpt-4.1-mini` model narrated intent without emitting the tool call), and nothing caught it because only *mark-done* had a verification step.
- **Verified:** the data layer is healthy — task API writes return `200` and persist, unknown IDs return `404 {"ok":false,"error":"Task not found"}`, and the old double-number `list_tasks` ID bug is already fixed (single `[#rowId]`). Gmail scanning (`scan_gmail_for_actions`) runs correctly in production.
- **Fixes:** extended the anti-hallucination + mandatory `list_tasks` verification to cover **move and delete** (not just mark-done); required explicit confirmation + similar-category check before `add_category`; forbade `add_task`/`update_task` from inventing categories.
- **Data cleanup:** merged duplicate categories `Others` → `Otros` and `golf club` → `Golf club`.
