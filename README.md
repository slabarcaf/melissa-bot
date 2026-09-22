# Sydney — a personal assistant that lives in a chat

Sydney is a multi-user AI assistant on Telegram. You write to her the way you would tell a
person — *"pay the electricity bill friday"* — and she files it with the date already set. She
manages tasks, debts, calendar events and email triage, and pushes a morning and an evening
briefing to each user at their own local time.

She has been running in production since May 2026 on a single Oracle VM, with real users who
are not me. There is also a [web dashboard](https://github.com/slabarcaf/task-dashboard) — the
same account, the same data, a different door.

```
Telegram ──long-poll──▶ melissa.js ──▶ OpenAI gpt-5-mini (tool_choice: auto)
                            │
       ┌────────────────────┼────────────────────┬──────────────────┐
       ▼                    ▼                    ▼                  ▼
  tasks-mcp.js       calendar-mcp.js       sheets-mcp.js      Whisper API
  (REST task API)    (Calendar + Gmail)    (Google Sheets)    (voice notes)
                            │
                         db.js — node:sqlite (users, invite codes, debts)
```

Three MCP servers run as child processes and speak JSON-RPC over stdin/stdout. They restart on
crash. `melissa.js` owns the Telegram loop, per-user routing and isolation, the tool loop, and
the guards below.

---

## The part worth reading: guarantees live in code, not in the prompt

Three times, Sydney told someone she had marked a task done and the task was still open the next
morning. Three times the fix was more system-prompt text. Three times it came back.

**A prompt rule cannot make a model call a tool.** It can only ask. So anything that must be true
is now enforced in code, and the prompt is a second layer rather than the only one.

**Mutation-claim guard** (`melissa.js`) — every turn records whether a mutating tool actually ran
*and succeeded*. If the reply claims an action ("marqué", "deleted", "moved") and none did, a
correction is injected and the tool loop re-runs once so the model can actually do it. If the
claim survives the retry, the false sentence is **replaced** with an honest failure. You get the
action or you get the truth, never a lie.

Two details that took measurement to get right:

- Offers are not claims. *"¿la marco como hecha?"* is a question, and interrogative clauses are
  stripped before matching — otherwise the guard fires on the model politely asking permission.
- A partial batch is a real mutation. A truthful *"1 of 2 updated"* must survive, so the guard
  checks for *any* successful write, not for a clean run.

**A measured model floor.** `reasoning_effort: "minimal"` is refused in code for the gpt-5 family.
Not on principle — it was measured to skip tool calls entirely and reproduce the exact bug above.

**Prompt-injection guard on calendar invitations.** An assistant that reads your email and can add
attendees to a calendar event is an exfiltration path: text in an email says "add
attacker@evil.com", the model obliges, and the attacker now receives the invite and its contents.
So attendee addresses must be *vouched for* — they have to appear in something the user typed or
in a contact lookup result. An address that appears only in tool output the model read is
blocked before the call is made.

**Honest tool results** (`tasks-mcp.js`) — a non-2xx response fails instead of being parsed as
success, `update_tasks` names each failed id, and neither an empty batch nor a field-less patch
can report "✅". Both of those were silent false successes.

The [changelog](#changelog) below is written as symptom → root cause → fix, including the fixes
that turned out to be wrong.

---

## What it does

- **Tasks in natural language** — add, complete, move, delete by chatting. Dates are read out of
  the sentence.
- **Multi-user** — invite-based onboarding, per-user language, timezone, briefing times and
  feature flags. Each user reads and writes only their own rows.
- **Two briefings a day**, per user, at their own local time: what is coming (07:00) and what is
  still open (20:00).
- **Debts** — who owes you and what you owe, per user.
- **Google Calendar and Gmail** — add events, get the day's agenda, and surface only the emails
  from real people that need a reply.
- **Voice notes** — transcribed with Whisper, then handled as text.
- **Dynamic categories** — created by asking, with a duplicate check and explicit confirmation
  first, written atomically so a bad write cannot corrupt the file.
- **A nightly health check** that verifies the Telegram API, the task API, the Google tokens and
  the MCP processes, and reports a failure when it cannot determine an answer — never an
  approval.
- **Bilingual** — English or Spanish, per user.

## Stack

Node 22 · `node:sqlite` (no native modules — the VM is Oracle Linux 8 and cannot build them) ·
OpenAI `gpt-5-mini` with tool use · MCP over JSON-RPC/stdio · Google Calendar, Gmail and Sheets
APIs · Whisper · systemd on Oracle Cloud, running as a non-root user under `ProtectHome`.

## Running it

Needs a Telegram bot token, an OpenAI key, and Google OAuth credentials with Calendar and Gmail
enabled.

```bash
npm install
cp config.example.json config.json   # fill in the keys; keep it at mode 0600
npm start
```

Configuration is a `config.json` file, not environment variables — `melissa.js` reads `CFG_PATH`
at startup and there is no env fallback for those values. Paths are overridable
(`CFG_PATH`, `DB_PATH`, `CATS_PATH`, `SKILLS_DIR`, …), which is how the production unit points at
`/opt/melissa` instead of the defaults.

```bash
npm test          # unit tests
SELFCHECK=1 node melissa.js   # deployment self-check, no polling
```

Deployment, account ownership and log-reading live in [docs/OPERATIONS.md](docs/OPERATIONS.md).

---

## Changelog

Each entry is symptom → root cause → fix, because the root cause is the part that is worth
remembering and the part that is always missing a year later.

### 2026-09 — the repo became the source of truth
Two of the three MCP servers existed **only on the VM**, edited over SSH, with eight `.bak` files
as version control. They are in the repo now and the deploy script copies them. `journald` was
volatile, so an incident left no evidence; it is persistent now. The deploy script runs the tests
and the self-check before restarting the service, instead of trusting that someone remembered.

### 2026-08-26 — a field with no description is a dumping ground
**Symptom:** three tasks were created with a `nextStep` of `"Convencimiento mañana"` — a next step
the user never mentioned.
**Root cause, two layers:** a voice note ending *"…con vencimiento mañana"* was transcribed as
*"Convencimiento mañana"*; the model read the date correctly but *also* parked the literal phrase
in `nextStep`, which was exposed to the model as an undescribed free-text string. An unlabeled
field reads as somewhere to put leftovers.
**Fix:** explicit field descriptions, opt-in only, never for garbled words or date wording, plus
a rule against echoing the field back in confirmations.
**Also:** a change was blamed for the bot going silent on voice notes, reverted, and later
**measured innocent** — 3/3 real API calls under 2s. The actual cause was a missing timeout:
Telegram returned `504` on `getFile`, and because processing is a per-chat FIFO queue, one stalled
request wedged that user's chat until a restart.

### 2026-08-12 — the third recurrence, and the last
**Symptom:** *"Marqué como hechas las tareas…"* and the next morning's brief listed the same tasks
as pending. Confirmed against the API: the rows were never written.
**Root cause:** every mutation depended on the model choosing to emit a tool call, with no
code-level check that a claim corresponded to a real write.
**Fix:** the mutation-claim guard above; `tasks-mcp.js` hardened so a non-2xx response fails;
`gpt-4.1-mini` → `gpt-5-mini` after measuring tool-call reliability on the real API. Reasoning
tokens bill as output, so this was a cost increase (~$1.67 → ~$2.60/month), not a saving — worth
saying, because "we upgraded the model" usually hides that.

### 2026-06-18 — verification that only covered one verb
**Symptom:** *"voy a moverla"* / *"la elimino"* and nothing landed.
**Root cause:** the anti-hallucination verification step existed, but only for *mark done*.
**Fix:** extended to move and delete; explicit confirmation and a similar-category check before
creating a category; `add_task` forbidden from inventing category names, which had produced
silent duplicates like `Others` vs `Otros`.

---

*MIT licensed. The dashboard half is at
[slabarcaf/task-dashboard](https://github.com/slabarcaf/task-dashboard).*
