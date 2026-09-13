# Melissa — Personal AI Assistant (Telegram)

Melissa (deployed as "Sydney") is a multi-user AI assistant that lives in Telegram. She manages tasks, debts, calendar events, email triage and networking follow-ups — and delivers per-user morning/evening briefings automatically every day.

## Identity and endpoints

| Item | Value |
|---|---|
| Telegram bot | **@Melizion_bot** (token in `config.json`) |
| Owner chat id | `<owner-chat-id>` (Santiago — the admin checks compare against this) |
| VM | `opc@$VM_HOST`, service `melissa-bot`, runtime `/opt/melissa/whatsapp-bot` |
| Task API | `https://task-dashboard-c7q2.vercel.app` (`task_api_base`) — cut over 2026-09-01 |
| Task dashboard repo | `~/demo/task-dashboard` → `github.com/slabarcaf/task-dashboard` (private) |
| Model | `gpt-5-mini`, shared by all users |

### Which account owns what

Two Google identities are in play — **Berkeley** (`santiago.labarca@berkeley.edu`) and **personal**
(`slabarcaf@gmail.com`) — plus GitHub as `slabarcaf`. Signing in to one is not enough to work on this
project, and guessing wrong is expensive: on 2026-09-11 two API keys were added to a Vercel project
that turned out to be an unrelated old React app in the other account, and three redeploys later
production still could not see them.

Every row says **how to check**, because a table that only asserts goes stale the first time
something moves, and the next person believes it.

| Service | Account | Holds | How to check you are in the right place |
|---|---|---|---|
| **GitHub** | personal — `slabarcaf` | Both repos: `melissa-bot` and `task-dashboard` | `git remote -v` in either repo shows `slabarcaf/…` |
| **Vercel** | **Berkeley** | The live dashboard, `task-dashboard-c7q2.vercel.app` | The project's **Deployments** tab shows today's commits from `slabarcaf/task-dashboard`. If it shows an old React app or no recent commits, wrong project |
| **Google Cloud** | Berkeley | OAuth clients — project number `<gcp-project-number>` | The client id starts `<gcp-project-number>-…` |
| **Neon** | Berkeley | The Postgres behind the task API — `us-east-1`, host `<neon-host>…aws.neon.tech` | `DATABASE_URL` in Vercel points at that host |
| **OpenAI** | — | `OPENAI_API_KEY` in Vercel (web voice notes) and `openai_api_key` in the VM's `config.json` (the bot) | `/admin` shows **Integraciones → Notas de voz** in green |
| **Resend** | — | `RESEND_API_KEY` in Vercel (invitation email) | `/admin` shows **Integraciones → Invitaciones por correo** in green |
| **Oracle Cloud** | — | The VM, `opc@$VM_HOST` with `~/.ssh/id_ed25519` | `ssh -i ~/.ssh/id_ed25519 opc@$VM_HOST 'sudo systemctl is-active melissa-bot'` |
| **Telegram** | — | @Melizion_bot, created in BotFather | The token in `config.json` answers `getMe` |

> ⚠️ **Corrected 2026-09-11.** This table used to say Vercel was `slabarcaf`. It is the Berkeley
> account. The personal account holds a *different*, unrelated project that is also called
> `task-dashboard` — an old create-react-app still serving at `task-dashboard.vercel.app`. Two
> projects, near-identical names, different accounts: that is the trap, and the reason the
> "how to check" column exists.

Consequences worth knowing before you touch anything:

- **Hosting, database and sign-in all sit on a university account.** Vercel, Neon and the Google
  OAuth client are all Berkeley. If that account is ever deactivated, the product loses its host, its
  data and its login in one move. Nothing is on fire today, but moving them to the personal account is
  the kind of work that is cheap now and impossible later. Do it one service at a time, never in the
  same session as a feature.
- **Vercel and GitHub are different identities**, so a push to `main` on `slabarcaf/task-dashboard`
  builds in a Vercel account reached with a different login. Adding an environment variable means
  signing in as Berkeley, not as `slabarcaf`.
- **The commit email must belong to the GitHub account** or Vercel refuses the build as `Blocked`.
  See the deployment note in `task-dashboard/README.md`.


## Features

- **Natural language task management** — add, update, complete, move, and delete tasks by chatting. Tasks are persisted in a hosted task dashboard. Every mutating action is checked **in code** before Melissa reports success: if her reply claims an action but no mutating tool actually ran, the claim is caught and either retried or replaced with an honest failure (see [Reliability guardrails](#reliability-guardrails)).
- **Multi-user** — invite-based onboarding with per-user feature flags, brief times, language, and timezone. Task ownership is enforced in app code on top of a single-tenant task dashboard, so each user sees and can modify only their own tasks and debts.
- **Finance / debts** — track who owes you and what you owe, per user, in SQLite.
- **Networking follow-ups** — contacts and next steps backed by a Google Sheet. **The daily 🤝 section is paused in production** (`networking_paused: true`, 2026-08-26); the tools still work on demand. See [Pausing a brief section](#pausing-a-brief-section).
- **Dynamic task categories** — categories live in `categories.json` (not hardcoded). Create a new one on the fly by chatting — "agrega la categoría Viajes" — but only with your explicit confirmation, and Melissa first checks that a same/similar category doesn't already exist before creating it.
- **Google Calendar integration** — add events and get your daily agenda via natural language.
- **Gmail triage** — scans multiple Gmail accounts and surfaces only emails from real people that need a reply.
- **Voice messages** — transcribes voice notes via OpenAI Whisper, then processes them as text.
- **Morning briefing** (per-user time, default 7 AM PT) — agenda, overdue/today tasks, and actionable emails in one formatted message.
- **Evening briefing** (per-user time, default 8 PM PT) — today's remaining tasks, tomorrow's agenda (🔜), and a check-in on what got done.
- **Nightly health check** (2 AM PT) — verifies Telegram API, Task API, Google OAuth tokens, and MCP server processes. Sends an alert if anything is broken.
- **Bilingual** — responds in English or Spanish depending on how you write to her.

---

## Architecture

```
Telegram ──long-poll──▶ melissa.js ──▶ OpenAI gpt-5-mini (tool_choice: auto,
                             │            reasoning_effort: low)
        ┌────────────────────┼────────────────────┬──────────────────┐
        ▼                    ▼                    ▼                  ▼
   tasks-mcp.js       calendar-mcp.js       sheets-mcp.js      Whisper API
   (Task Dashboard)   (Google Calendar      (Networking        (voice
                       + Gmail)              Google Sheet)      transcription)
                              │
                           db.js — SQLite: users, invite codes, debts
```

- **`melissa.js`** — main bot loop. Handles Telegram long-polling, onboarding, per-user routing and isolation, routes messages through the model with tool use (`chatCreate`), enforces the mutation-claim guard, and manages conversation history per chat.
- **`db.js`** — SQLite (`node:sqlite`) store for users, invite codes, and debts. Debts are isolated per user with `WHERE user_id = ?`.
- **`tasks-mcp.js`** — MCP server wrapping the task dashboard REST API (list, add, update, delete tasks, and add categories). Loads the category list from `categories.json` at startup.
- **`categories.json`** — the source of truth for task categories and their inference keywords. Read by both `melissa.js` (to build the system prompt) and `tasks-mcp.js` (to validate task categories). Editable by hand or via the `add_category` tool.
- **`calendar-mcp.js`** — MCP server wrapping Google Calendar and Gmail APIs via OAuth.
- **`sheets-mcp.js`** — MCP server wrapping the Networking Google Sheet (contacts and follow-ups).
- All three MCP servers are spawned as child processes and communicate over stdin/stdout (JSON-RPC). They auto-restart on crash.

> **Repo boundary:** desde 2026-09-13 el repo manda sobre todo lo que corre. El script despliega `melissa.js` (como `whatsapp-bot.js`), `db.js`, `prefs.js`, `package.json`, `package-lock.json` y los tres servidores MCP. `categories.json` está en el repo pero el script **no** lo copia.

---

## Setup

### Prerequisites

- Node.js 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenAI API key
- A Google Cloud project with Gmail + Calendar APIs enabled, and OAuth2 credentials
- Los tres servidores MCP (`tasks-mcp.js`, `calendar-mcp.js`, `sheets-mcp.js`) — **en este repo**, desplegados a `SKILLS_DIR`

### Install

```bash
git clone https://github.com/yourusername/melissa-bot.git
cd melissa-bot
npm install
```

### Configure

Configuration is read from a **`config.json` file**, not from `.env` — `melissa.js` parses `CFG_PATH` at startup and there is no environment fallback for these values. (`.env.example` is legacy; it documents the same keys in a format the code no longer reads.)

```jsonc
{
  "telegram_token": "…",              // from BotFather
  "telegram_chat_id": "…",            // the owner's Telegram user ID
  "openai_api_key": "sk-…",
  "openai_model": "gpt-5-mini",
  "openai_reasoning_effort": "low",   // gpt-5 family only; NEVER "minimal" (see Reliability guardrails)
  "task_api_base": "https://…",
  "task_api_secret": "…",             // also passed to tasks-mcp.js as TASK_API_SECRET
  "google_client_id": "…",
  "google_client_secret": "…",
  "google_refresh_token": "…",              // primary Gmail/Calendar account
  "google_refresh_token_berkeley": "…",     // secondary account
  "network_sheet_id": "…",            // Networking Google Sheet
  "timezone": "America/Los_Angeles",

  // Optional pause flags. Both default to false (absent = false). They suppress a
  // section of the *push* briefing only — the underlying tools stay live, so the
  // feature still answers when asked for directly. See "Pausing a brief section".
  "morning_emails_paused": false,     // drop 📬 EMAILS from the morning brief
  "networking_paused": true           // drop 🤝 NETWORKING from the morning brief
}
```

Paths are overridable by environment variable, which is how the production unit points the bot at `/opt/melissa` instead of the `/root` defaults: `CFG_PATH`, `DB_PATH`, `CATS_PATH`, `USAGE_LOG`, `USAGE_DIR`, `PRIORITY_FILE`, `SKILLS_DIR`.

Keep `config.json` at mode `0600` — it holds every credential, and it is gitignored.

### Run

```bash
npm start
```

---

## Production deployment (Oracle VM)

The bot runs as a `systemd` service on an Oracle Cloud VM.

The service runs as the **non-root user `melissa`** under `/opt/melissa` (migrated off root in July 2026). The unit is `melissa-bot`; the old root `whatsapp-bot` unit is disabled but retained as an instant rollback.

```bash
# View logs
sudo journalctl -u melissa-bot -f

# Restart after changes
sudo systemctl restart melissa-bot

# Check status
sudo systemctl status melissa-bot

# Did the mutation-claim guard catch a false completion?
sudo journalctl -u melissa-bot --no-pager | grep '\[guard\]'
```

To deploy a code change, push to GitHub and run the deploy script on the server:

```bash
# From any machine with an authorized SSH key (~/.ssh/id_ed25519)
ssh -i ~/.ssh/id_ed25519 opc@<VM_IP> 'sudo /root/deploy-melissa.sh [branch]'   # default branch: main
```

The script (`/root/deploy-melissa.sh` on the VM) pulls the branch via a read-only GitHub
deploy key, copies the files into place
(`melissa.js` → `/opt/melissa/whatsapp-bot/whatsapp-bot.js`, `db.js`, `package.json`;
`sheets-mcp.js` → `/opt/melissa/.openclaw/skills/`), runs `npm install`, and restarts `melissa-bot`.

Server facts worth remembering:
- The VM is Oracle Linux 8 — native npm modules that need glibc ≥ 2.29 or Python ≥ 3.8 **will not build**. SQLite is provided by Node 22's built-in `node:sqlite` for this reason (no `better-sqlite3`).
- `/opt/melissa/whatsapp-bot/` is the runtime dir (not a git repo), owned by user `melissa`; `config.json` is `0600`.
- MCP servers live in `/opt/melissa/.openclaw/skills/` y **los tres están en este repo** desde 2026-09-13; el script de despliegue los copia. Antes `tasks-mcp.js` y `calendar-mcp.js` se editaban directamente en la VM, y su control de versiones eran ocho archivos `.bak`. El árbol de `/root/.openclaw/skills/` queda como parte del camino de rollback, no como destino de despliegue.
- **journald is volatile** (no `/var/log/journal`), so logs disappear within hours. Make it persistent before relying on logs to diagnose an incident.
- SSH keys authorized for `opc`: Santiago's Mac and Windows PC (`windows-pc-melissa`).

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

## Pausing a brief section

Some briefing sections can be switched off without removing any code or changing a
user's feature flags, via boolean flags in `config.json`:

| Flag | Suppresses | Currently |
|---|---|---|
| `morning_emails_paused` | 📬 EMAILS in the morning brief | off (section shows) |
| `networking_paused` | 🤝 NETWORKING (follow-ups) in the morning brief | **on — paused since 2026-08-26** |

The flag only stops the brief from *calling* the tool (`scan_gmail_for_actions` /
`list_contacts`), so the section drops out of the push message. Everything else is
untouched: the tools stay registered, the system-prompt sections stay, and per-user
`features.*` flags are unchanged — asking for the thing directly still works.

To resume, set the flag to `false` in `config.json` and restart:

```bash
ssh opc@$VM_HOST 'sudo systemctl restart melissa-bot'
```

Verify without waiting for the 7 AM cron by running `buildBriefingText` against the
live config — see the handoff's cheat-sheet.

---

## Reliability guardrails

> **Design principle, learned the hard way:** prompt rules cannot *make* a model call a tool. The same class of bug — Melissa confirming an action she never performed — recurred three times while the only defense was more system-prompt text. Guarantees that must hold now live in **code**.

- **Mutation-claim guard** (code, `melissa.js`) — every turn tracks whether a mutating tool actually ran **and succeeded**. If the reply claims an action ("marqué", "eliminé", "moved", "updated") and none did, a correction is injected and the tool loop re-runs once so the model can actually perform it. If the claim survives that retry, the false text is **replaced** with an honest failure notice. You get the action or the truth, never a lie. Caught cases are logged as `[guard] unverified mutation claim`.
  - Offers are not claims: interrogative clauses ("¿la marque como hecha?") are stripped before matching.
  - Partial batch writes count as real mutations, so a truthful "1 of 2 updated" reply is never overwritten.
- **Honest tool results** (code, `tasks-mcp.js`) — a non-2xx API response fails instead of being parsed as success, `update_tasks` names each failed task id, and neither an empty `updates` array nor a field-less patch can report "✅" (both were silent false successes).
- **Model floor** — `reasoning_effort: "minimal"` is **refused** for the gpt-5 family: it was measured to skip tool calls entirely and reproduce the exact bug above. Use `low` or higher.
- **Mandatory post-action verification** (prompt) — after every mutation Melissa re-reads with `list_tasks` and confirms the change landed. This is still useful, but it is now a second layer behind the code guard, not the only one.
- **Category integrity** — task `tipo` values must match an existing category exactly; new categories require explicit user confirmation and a duplicate check (see [Adding a category](#adding-a-category)).

---

## Changelog

### 2026-08-26 — nextStep field discipline, networking paused, an open voice-path defect
- **Symptom:** three tasks were created with the due date right but a bogus `nextStep` of `"Convencimiento mañana"`, echoed back in the confirmation — for a "next step" the user never mentioned.
- **Root cause (two layers):** a voice note ending "…**con vencimiento** mañana" was transcribed by Whisper as "**Convencimiento** mañana"; the model parsed the date correctly but *also* parked the literal phrase in `nextStep`, which was exposed on `add_task`/`update_task` as an **undescribed** free-text string and was never mentioned in the system prompt — an unlabeled field reads as a dumping ground.
- **Fixes:** `nextStep` (and `dueDateNextStep`) now carry explicit descriptions via a shared `NEXT_STEP_FIELD_DESC` — opt-in only, never for leftover/garbled words, never for due-date wording; matching rule added to the `add_task` prompt block, plus "never echo `nextStep` in confirmations". Rows 515–517 had `nextStep` cleared via the task API.
- **Networking:** the daily 🤝 section is paused behind `networking_paused` (see [Pausing a brief section](#pausing-a-brief-section)). Nothing removed.
- **A Whisper vocabulary prompt was shipped and reverted** — and the revert was a **false alarm**. It was blamed for the bot going silent on voice notes; it was later measured innocent (3/3 real API calls under 2s with the exact string; multipart `Content-Length` correct with accents). The constant survives, unused and documented, in `melissa.js`.
- **⚠️ Open defect (not fixed):** `tgRequest` and `downloadFile` set **no timeout**. Telegram returned `504 Gateway Timeout` on `getFile`, and because processing is a per-chat FIFO queue, one stalled Telegram request wedges that user's chat **indefinitely** — the bot answers nothing until a restart. This is what actually caused the silence. See the 2026-08-26 handoff.

### 2026-08-12 — false-completion fix, model upgrade, MCP write hardening
- **Symptom:** Melissa replied "Marqué como hechas las tareas..." and the next morning's brief still listed the same tasks as pending. Confirmed against the task API — the rows were never written. This was the third recurrence of the same class of bug, after two prompt-only fixes.
- **Root cause:** every mutation depended on the model choosing to emit a tool call, with **no code-level check** that a claim corresponded to a real write.
- **Fixes:** added the [mutation-claim guard](#reliability-guardrails) in `melissa.js` (catch → retry → honest failure); hardened `tasks-mcp.js` so `apiFetch` fails on non-2xx and `update_tasks` can no longer report an empty/no-op batch as success; removed a hardcoded `TASK_API_SECRET` fallback from source.
- **Model:** `gpt-4.1-mini` → **`gpt-5-mini`** with `reasoning_effort: low`, after measuring tool-call reliability on the real API. `minimal` reproduced the bug and is now refused in code. Reasoning tokens bill as output, so this is a modest cost increase (~$1.67 → ~$2.60/mo at current volume), not a saving.
- **Also:** all three per-turn completion calls routed through one `chatCreate()` helper; `OPENAI_MODEL` passed to `tasks-mcp` so usage reports price against the model actually in use; per-tool outcomes logged as `[tool:done]`.

### 2026-06-18 — task-action reliability fix
- **Symptom:** Melissa would say "voy a moverla / la elimino" for a task but the change never landed — the move/delete was never executed (the `gpt-4.1-mini` model narrated intent without emitting the tool call), and nothing caught it because only *mark-done* had a verification step.
- **Verified:** the data layer is healthy — task API writes return `200` and persist, unknown IDs return `404 {"ok":false,"error":"Task not found"}`, and the old double-number `list_tasks` ID bug is already fixed (single `[#rowId]`). Gmail scanning (`scan_gmail_for_actions`) runs correctly in production.
- **Fixes:** extended the anti-hallucination + mandatory `list_tasks` verification to cover **move and delete** (not just mark-done); required explicit confirmation + similar-category check before `add_category`; forbade `add_task`/`update_task` from inventing categories.
- **Data cleanup:** merged duplicate categories `Others` → `Otros` and `golf club` → `Golf club`.
