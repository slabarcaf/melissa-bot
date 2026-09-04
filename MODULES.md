# Modules

What Sydney can actually do, per module: what a user says, what happens, and who is allowed to.
`README.md` lists capabilities; this file is the user-facing behaviour behind them.

## The `features` flag

Every account carries a JSON `features` object in `users.features`. Five flags exist:

| Flag | Module | Who has it today |
|---|---|---|
| `tasks` | Tasks | everyone |
| `finanzas` | Debts | everyone |
| `calendar` | Google Calendar + Contacts | Santiago only |
| `email` | Gmail triage | Santiago only |
| `networking` | Networking sheet | Santiago only |

**Invited users get `{ tasks: true, finanzas: true }`.** The other three are not withheld as a
product tier — they are withheld because the MCP servers boot with **one global Google OAuth token**.
Turning `calendar` on for another person would hand them Santiago's own Google account. Fixing that
(per-user OAuth) is Phase 5 of `PLAN-2026-09-01-producto.md`. Do not flip those flags for anyone
else before it lands.

Enforcement is two-layered, deliberately:

1. `filterToolsForUser()` — the disabled tools are never offered to the model.
2. `callTool()` re-checks `TOOL_FEATURE` server-side before executing anything (security item F5).
   Never trust the tool list alone; a stray or injected tool name must still be refused.

**What a user with a module off experiences:** they simply cannot get it, and Sydney declines
naturally. The refusal string is a *directive to the model*, not text shown verbatim — it tells the
model to explain kindly that it can only help with tasks and debts, without mentioning tools or
anything technical. Users should never see the word "tool" or a feature flag name.

## Tasks (`tasks`)

The core module. Backed by the Task Dashboard API, not the local database.

**Adding.** Say what needs doing and when: *"agrega tarea: revisar el contrato, para el jueves"*.
Sydney infers the category and asks to confirm it unless the user named one (*"en finanzas"*). If
the due date is missing it asks. Dates are flexible on input — "mañana", "el viernes", "15 de julio",
"tomorrow" all work.

**Listing.** *"tareas"*, *"qué tengo"*, *"pendientes"*, *"mis tareas"*, *"show tasks"*. Default view
is overdue + today. Tasks are grouped by category, each category heading appearing exactly once.
Due dates display as `3-Mar`, with the year appended only when it is not the current year.

**Completing.** Plain words: *"ya la hice"*, *"listo"*, *"terminé lo del contrato"*, *"done"*. All of
them map to the status `Done`. Users never need an ID.

**Editing and deleting.** *"muévela a finanzas"*, *"elimina la tarea de revisar el contrato"*.
Deletion always confirms the task name first.

**Priority.** *"urgente"*, *"importante"*, *"asap"* marks a task 🔴 and floats it to the top.
Stored as `tasks.is_priority` in the database since 2026-09-01, so the bot and the web agree on it.

**Categories.** Each user has their own list, chosen during onboarding. A new one is created only
when the user explicitly asks, and Sydney warns if a similar one already exists — this prevents the
duplicate categories ("Others" vs "Otros") that had to be cleaned up in June 2026.

**Recurring tasks** are supported by the API (daily/weekly/monthly). Completing one automatically
creates the next occurrence.

## Debts (`finanzas`)

Who owes the user money and who they owe. Stored in **SQLite on the VM**, hard-isolated by `user_id`.

**Adding.** *"Juan me debe 50 dólares por un asado"*, *"le debo a María 200 pesos"*. Sydney confirms
name, amount, currency and direction in one message before saving. Missing currency defaults to USD
and it says so.

**Listing.** *"quién me debe"*, *"mis deudas"*. Filters: pending (default), paid, owed-to-me,
owed-by-me.

**Settling.** *"ya le pagué a Juan"*, *"María ya me pagó"*.

Pending debts also appear in the morning brief.

## Calendar (`calendar`) — Santiago only

Google Calendar on the Berkeley account, plus Google Contacts lookup.

*"agrega a mi calendario"*, *"agenda esto"*, *"qué tengo en el calendario"*. Modifying an existing
event never creates a new one — Sydney looks up the event id first. Adding attendees always requires
explicit confirmation of the email address, even when Contacts finds it.

## Gmail triage (`email`) — Santiago only

Scans both accounts and surfaces **only** mail from a real individual writing personally: a person
asking something, a recruiter following up, a contract needing review. Everything from an
organization, newsletter, airline, university office, job board or automated notification is
dropped. The rule when uncertain is to skip — missing a company email costs less than noise.

Triggered by any mention of email, correo, inbox, or "revisa correo".

**Currently paused in the morning brief** via `morning_emails_paused` in `config.json`. The tools
still answer on demand; only the automatic section is off.

## Networking (`networking`) — Santiago only

A Google Sheet of contacts and follow-ups. *"agrega a networking"*, *"conocí a…"*, *"contáctalo en
3 meses"*. Overdue follow-ups surface in the morning brief.

**Paused since 2026-08-26** via `networking_paused` in `config.json` — the daily brief section is
off, the tools still answer when asked directly. Nothing was removed.

⚠️ This sheet has **no per-user isolation at all**. It must not be enabled for anyone else before
that is fixed.

## Briefs

**Delivered through Telegram only** (decided 2026-09-02). An account that has never connected
Telegram receives no briefs at all, which is the main practical reason to connect it. There is no web
push and none is planned.

Not a flag — a scheduled push assembled from whichever modules a user has. Each user picks their own
times during onboarding (defaults 07:00 and 20:00), scheduled in their own timezone, and can change
them any time: *"mándame el brief a las 8"*, *"ya no quiero el de la noche"*.

- **Morning**: today's agenda, overdue + today's tasks, actionable email, pending debts, due
  follow-ups. Sections with no content are omitted.
- **Evening**: overdue + today's tasks, tomorrow's agenda, then asks what got done.

A section only appears if the user has that module *and* it is not paused globally.

## Voice

Any user can send a voice note instead of typing. It is transcribed with Whisper using the user's
chosen language as a hint (autodetecting until they pick one during onboarding), then handled exactly
like typed text. This is advertised in the first onboarding message because it is otherwise
undiscoverable.

## Usage reporting — Santiago only

`get_usage` reports token counts and estimated cost for a month, and a report is pushed on the 1st.
Not gated by a `features` flag; it is refused for anyone who is not Santiago.
