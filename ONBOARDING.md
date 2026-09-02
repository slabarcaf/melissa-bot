# Onboarding

How a new person becomes a Sydney user, end to end. This is the **specification**, not a
description: the planned web onboarding (see `PLAN-2026-09-01-producto.md`, Phase 4) must ask the
same questions in the same order and store the same fields. If the two ever diverge, a user who
signs up on the web and one who signs up on Telegram end up with different accounts.

Implementation: `handleOnboarding()` in `melissa.js`, message strings in the `OB` table and
`OB_WELCOME` just above it. Everything a step writes goes to the `users` table in `db.js`.

**To try the flow without a Telegram account, open `onboarding-lab.html`** in a browser — a
self-contained sandbox with no backend. It runs the real state machine and ports the parsers
verbatim, so answers behave exactly as they do in production, and a side panel shows what each one
writes to the user row. It also carries a first-cut proposal for the web version. When the flow
changes, update the lab in the same commit or it starts lying.

## Design rules (why it looks like this)

These came out of watching the first invited user (the second user) go through v1 in July 2026. Keep them.

1. **One idea per message.** v1 ended with a single wall of text covering tasks, debts, completion
   and deletion. Nobody reads that. The tutorial is now two small chunks, each ending with something
   to reply to.
2. **Never ask for a timezone.** v1 showed an IANA reference table (`America/Santiago`, …). Ask for
   a city and country and infer it.
3. **Say up front that voice notes work.** The bot has always transcribed audio, but a conversation
   that opens with plain text never reveals it.
4. **Ask language first**, before anything else, so every later message is in the user's language.
5. **Keep it under ten steps.** It is nine.

## Entry: the invite

Onboarding is invite-only. There is no open sign-up.

1. Santiago sends `/invite <Name> [email@example.com]` (his chat only).
2. The bot mints an 8-character code over a 32-symbol alphabet, prefixed `MELI-`, valid **30 days**,
   single use. It replies with a `https://t.me/<bot>?start=<CODE>` link as a tap-to-copy code span.
   If an email was given, it also sends the invitation through the Gmail API.
3. The invitee opens the link, which sends `/start <CODE>`.
4. On a valid code the bot creates the user row with `features: { tasks: true, finanzas: true }` —
   **email, calendar and networking stay Santiago-only** (see `MODULES.md`) — and immediately calls
   `handleOnboarding` with empty text, so the welcome arrives without the user typing anything.
5. On a bad code: `❌ Ese código no es válido o ya fue usado.` After 5 failures in 10 minutes that
   chat is silently ignored for 30 minutes (brute-force throttle, security item F3). During the
   cooldown the bot does not answer at all — that silence is deliberate, not a bug.

Unregistered chats that message the bot are ignored entirely and logged as `[ignored] unregistered`.

## The nine steps

State lives in `users.onboarding`. Every message the user sends while it is not `done` is routed to
`handleOnboarding` and never reaches the LLM. The legacy v1 state `awaiting_tz` is remapped to
`awaiting_location` on entry, so a user stranded mid-v1 resumes cleanly.

| # | State | Asks | Writes |
|---|-------|------|--------|
| 1 | `new` → `awaiting_language` | Welcome + language | — |
| 2 | `awaiting_language` | Name | `language` |
| 3 | `awaiting_name` | City + country | `preferred_name` |
| 4 | `awaiting_location` | Brief times (or confirm timezone) | `timezone` |
| 4b | `awaiting_tz_confirm` | Brief times | `timezone` |
| 5 | `awaiting_briefs` | (tutorial part 1) | `brief_morning`, `brief_evening` |
| 6 | `awaiting_tasks_ack` | (tutorial part 2) | — |
| 7 | `awaiting_debts_ack` | Preset categories | — |
| 8 | `awaiting_cats` | Custom categories | `categories` |
| 9 | `awaiting_custom_cat` → `done` | — | `categories`, `onboarding` |

### 1. Welcome and language (`new`)

The only bilingual message, since the language is not known yet. Also the only place voice input is
advertised.

> ¡Hola! Soy **Sydney** 👋 Tu asistente personal. / Hi! I'm **Sydney** 👋 Your personal assistant.
>
> 🎤 Puedes escribirme por texto o mandarme **notas de voz**, como prefieras. / You can text me or
> send me **voice notes**, whatever's easier.
>
> Primero lo primero — ¿en qué idioma quieres que hablemos? / First things first — which language
> should we use?
> 👉 **español** / **english**

### 2. Language → name (`awaiting_language`)

`parseLanguageChoice`: matches `espa|spanish|castellano` → `es`; `english|inglés|en|eng` → `en`;
**anything unrecognized defaults to `es`.** Stored in `users.language`, which also becomes the
Whisper transcription hint (it is `NULL` until this point precisely so Whisper autodetects during
step 1).

> Perfecto, español 🙌 / Great, English it is 🙌
>
> ¿Cómo quieres que te llame? / What should I call you?

### 3. Name → location (`awaiting_name`)

`sanitizeName` takes **only the first whitespace-separated token**, strips everything that is not a
Unicode letter or digit, and caps it at 30 characters. Empty result falls back to `Amigo`. This is a
security control (F6), not cosmetics: the name is spliced into the system prompt later, so it must
not be able to carry instructions or a fake `[uid:]` tag.

> ¡Mucho gusto, {name}! 👋
>
> ¿En qué ciudad y país estás?
> (Así te muestro fechas y recordatorios en tu hora local)

### 4. Location → briefs (`awaiting_location`)

`parseCityToTimezone` walks `CITY_TZ_TABLE` in order and returns `{ tz, matched }`. It also accepts
a raw IANA string (`America/Bogota`) if someone types one.

**Order in that table is load-bearing.** Country names ending in "la" — Venezuela, Guatemala — are
matched *before* the generic `\bla\b` → Los Angeles rule. Moving that last row up silently sends
Caracas users to California. There is a regression test for this case.

- **Recognized** → save the timezone, go straight to step 5. No extra confirmation.
- **Not recognized** → save the Americas default (`America/Los_Angeles`), go to `awaiting_tz_confirm`.

### 4b. Timezone confirmation (`awaiting_tz_confirm`)

Only reached when the city was not recognized.

> Mmm, no ubico bien esa ciudad 😅 Voy a asumir la zona horaria **{tz}**.
>
> ¿Está bien? (responde **sí**, o dime otra ciudad)

`sí|yes|ok|dale|correcto|claro|sure|yep|yeah` accepts. Anything else is re-parsed as a city; if that
also fails the guess is kept with an apology and onboarding continues. **One retry, never a loop** —
a user must never be trapped on this question. The timezone is easy to fix later by telling the bot
a city in normal conversation.

### 5. Brief times (`awaiting_briefs`)

> ✅ Zona horaria: **{tz}**
>
> Ahora — ¿quieres que te mande **briefs**? Son resúmenes con tus tareas y pendientes del día.
>
> Normalmente recomendamos dos: uno en la mañana (7:00 am) y uno en la noche (8:00 pm). Pero dime
> tú: ¿cuántos quieres y a qué hora?

`parseBriefTimes` returns `{ morning, evening }` as `HH:MM`, where `''` means that brief is off:

- A negative answer with no digits (`no`, `ninguno`, `none`, `nada`) → both off.
- Up to two times are extracted, accepting `7`, `7am`, `19:30`, `8 pm`.
- `solo`/`only`/`just`/`uno` plus a mention of morning or night restricts it to that one.
- A single bare hour under 12 with no meridiem is read as morning; if the answer is clearly about
  the evening it is shifted to PM.
- With two times, the earlier becomes the morning brief and the later the evening one.
- **Anything unparseable keeps the 07:00 / 20:00 defaults.** The confirmation always states what was
  actually set, so a misparse is visible immediately rather than silent.

The confirmation always ends by saying the user can write **at any hour**, not just at brief time.
That sentence exists because testers assumed the bot only spoke during briefs.

### 6–7. Tutorial, in two chunks

Part 1 covers tasks and completing them; part 2 covers debts. Each ends with a question, and **any
reply advances** — the state machine does not try to interpret it. A user who asks a real question
here gets moved along; the LLM answers it properly once onboarding finishes.

Full text lives in `OB[lang].tutorialTasks()` and `OB[lang].tutorialDebts()`.

### 8. Preset categories (`awaiting_cats`)

The eight `PRESET_CATEGORIES` are listed numbered: Work, Estudios, Salud, Personal, Side Projects,
Finanzas, Networking, Otros. `parseCategorySelection` accepts numbers (`1, 3, 5`) or names,
case-insensitively. **If nothing parses, it falls back to the first and last preset** (Work + Otros)
rather than leaving the user with none.

### 9. Custom categories (`awaiting_custom_cat`)

> ✅ Categorías guardadas: **{names}**.
>
> ¿Quieres agregar alguna categoría tuya? Dime los nombres separados por coma (ej: *Viajes,
> Iglesia*) — o responde **no**.

`no|nope|nel|n` finishes. Otherwise the answer is split on commas and each name is sanitized to
letters, digits and spaces, capped at 30 characters. Names that duplicate an existing or preset
category are skipped case-insensitively, and bare affirmations (`sí`, `ok`, `dale`) are filtered out
so "sí, Viajes" does not create a category called "sí".

Then: `onboarding = 'done'`, **`scheduleCrons()` is called** so the user's brief crons come into
existence, and the closing message goes out. A user is invisible to the brief scheduler until this
moment — `getDoneUsers()` only returns `onboarding = 'done'`.

## After onboarding

`handleMessage` stops routing to the state machine and the user reaches the LLM with their own
system prompt, their own categories, and only the tools their `features` flags allow.

## Administration

Santiago-only, handled before the LLM in the polling loop:

| Command | Effect |
|---|---|
| `/users` | Every account: name, chat id, state, timezone, language, brief times, features |
| `/invite <Name> [email]` | Mint an invite code, optionally email it |
| `/resetuser <id>` | Set `onboarding = 'new'` and re-send the welcome. **Keeps tasks, debts, categories and settings.** Drops that user's brief crons until they finish again |
| `/deleteuser <id> confirm` | Delete the account and its debts. Two-step: without `confirm` it only shows what will be lost |

Both destructive commands refuse to target Santiago's own chat id, and refuse an id that is not in
the database.

`/resetuser` is the intended way to walk an existing user through a revised onboarding — it is how
the second user would see this version.

## Known gaps

- **The web has no onboarding yet.** The Task Dashboard has its own unrelated first-login category
  picker, which is *not* this flow and does not create a Sydney user. Reconciling them is Phase 4.
- **A reset user keeps their old categories**, and step 9 skips duplicates, so re-running onboarding
  cannot produce duplicated categories — but it also will not remove categories they no longer want.
- **No way for a user to restart their own onboarding.** Only Santiago can, via `/resetuser`.
