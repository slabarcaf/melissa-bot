# How someone becomes a user — target design

Written 2026-09-02. This is the **design we agreed**, not what exists yet. `ONBOARDING.md` describes
what runs in production today; this file describes where it is going and why. Every section marks
what is already built.

## The problem with today's flow

Getting in currently requires Telegram, in this order: Santiago runs `/invite`, the invitee gets a
`t.me` link, and every question — language, name, city, categories, brief times — is answered inside
a chat.

That means someone who just wants a task list has to install Telegram, find a bot, and hold a
conversation before seeing anything. And the web makes it worse rather than better: signing in with
Google creates a real account, shows an unrelated category picker, and lands on an **empty
dashboard**. That is not hypothetical — six people did exactly that:

| | |
|---|---|
| Accounts created by Google sign-in | 8 |
| …that are linked to Telegram | 2 (Santiago, the second user) |
| …that have any task at all | 4 |
| …that went through the category picker and then saw nothing | 4 |

The web account and the Telegram chat had no way to become the same person. That is the gap.

## The target: web first, Telegram as an upgrade

**The web becomes the default door.** It is where the experience can be controlled, explained and
made to look like something. Telegram stays, but as what it actually is: the best way to *capture*
something while walking, and the thing that delivers the daily briefs. That is a reason to connect
it, not a prerequisite for existing.

Concretely, this is what a new person goes through.

### 1 · The invite

Santiago names a person and an email. Two entry points, same result:

- **From the web** (to build): Settings → Invitations → name + email → Send.
- **From Telegram** (exists): `/invite <Nombre> [email]`.

Both create an invite record and send an email. The Telegram command stays because it is genuinely
faster from a phone.

> **Today:** `/invite` exists and already sends mail through the Gmail API — but as **plain text**,
> and the link it sends is a `t.me` link into the bot, not into the web.

### 2 · The email

One clear HTML message: what Sydney is, who invited them, and a single button — **Crear mi cuenta** —
pointing at `https://<dashboard>/invite/<token>`.

Design notes for when it gets built: it must survive Gmail's clipping and dark mode, so tables for
layout, inline styles, no external CSS, a plain-text alternative part, and a visible fallback URL
under the button. Keep the token out of the subject line.

> **Today:** plain-text mail with a `t.me` link. Needs rewriting once the web invite page exists.

### 3 · Web onboarding — the default path

`/invite/<token>` shows the pitch, then **Continuar con Google**. Signing in consumes the token and
creates (or claims) the account, so the invite and the identity are bound in one step.

Then the same questions the bot asks, in the same order, because `ONBOARDING.md` is the spec for both
doors — but taking advantage of being a browser:

| Step | In the browser |
|---|---|
| Name | Prefilled from the Google profile; editable |
| Language | Two cards |
| **Timezone** | **Detected, not asked.** `Intl.DateTimeFormat().resolvedOptions().timeZone` already knows. Show it and let them change it — the city-guessing that Telegram has to do disappears entirely |
| Categories | Chips, multi-select, plus your own |
| Briefs | Times picked directly. Explain that briefs arrive **through Telegram**, which is what motivates the next step |

> **Today:** none of this exists. There is an unrelated first-login category picker in `page.tsx`
> that writes `users.tipo_options`; it is not this flow and should be replaced by it.

### 4 · Connecting Telegram — optional, from Settings

This is the piece that makes the two halves one account, and **it is built and live**.

1. Settings → Telegram → **Conectar**.
2. The browser calls `POST /api/telegram/link` and gets a single-use code, valid 24 hours.
3. The page shows two ways to use it:
   - a **tappable link** — `https://t.me/Melizion_bot?start=link_<CODE>` — which is one click on a
     phone, and
   - the code itself with a copy button, for `/link <CODE>` typed by hand.
4. The bot redeems it against `POST /api/telegram/redeem`, sets `users.telegram_chat_id`, and
   confirms by name.
5. Settings now shows **Conectado** and a Desconectar action.

#### What the tappable link actually does, per situation

A `t.me` link is a real web page *and* a universal/app link, so it degrades instead of breaking — but
one common case it does not solve at all.

| Situation | What happens |
|---|---|
| **Telegram installed, iOS or Android** | The OS opens the Telegram app straight at the bot, with a START button. Identical on both platforms — this is not an iOS-versus-Android problem |
| **Telegram not installed** | `t.me` opens as an ordinary web page offering the app stores. **The flow is not lost:** the `start=link_…` payload stays in the URL, so after installing, the same link works. But it *is* interrupted — install, create an account, verify a phone number — which is why link codes now last **24 hours** instead of 15 minutes. A 15-minute code guaranteed they came back to a dead one |
| **Telegram Desktop installed** | `t.me` offers to hand off to the desktop app |
| **Neither, on a laptop** | `t.me` offers Telegram Web (`web.telegram.org`), which works in the browser |
| **⚠️ Dashboard on a laptop, Telegram on the phone** | **The link is useless here** — tapping it on the laptop tries to open Telegram on the laptop. This is probably the *most* common case, and it is why the code must always be shown too |

So the Settings screen has to offer three things, not one:

1. **The tappable link**, for someone on the phone that has Telegram.
2. **A QR code** of that same link, for the laptop-to-phone case — scan it and the phone opens Telegram
   at the right place. This is the piece that makes the common case work.
3. **The code itself, with a copy button**, as the fallback that always works: open Telegram anywhere
   and type `/link ABC12345`.

Plus an honest "I don't have Telegram" line that says what installing involves and that the code
keeps working, rather than letting someone tap into a store and lose the thread.

Refusals are specific on purpose, because "invalid code" tells nobody what to do:

| Reason | What the bot says |
|---|---|
| `not_found` | The code does not exist — generate a new one |
| `expired` | Codes last 24 hours — generate a new one |
| `used` | Already used — generate a new one |
| `chat_taken` | This Telegram is already connected to another account |

Two security properties worth keeping if this is ever refactored:

- **Minting requires a browser session, never the bot token.** `/api/telegram/link` is cookie-auth
  only. If the shared bot secret could mint codes, anyone holding it could claim any account.
- **Redeeming has no owner fallback.** Unlike the task routes, `/api/telegram/redeem` refuses an
  unknown token outright, because the chat id in the body is precisely what is being granted access.
- A chat can only ever point at one person; redeeming from a phone linked to somebody else is
  refused rather than quietly moving that chat's tasks.

> **Built and verified 2026-09-02:** the table, both routes, the `/link` command and the
> `?start=link_…` deep link. Tested against production for all five paths — valid, unknown, reused,
> expired, and a chat already belonging to someone else.

### 5 · What the bot still asks after linking

Preferences live in two places today: the web's `users` row in Postgres (email, name,
`telegram_chat_id`, `tipo_options`) and the bot's own SQLite row (language, timezone, brief times,
categories, feature flags). Linking joins the identities, not the settings.

So after `/link` the bot runs its normal onboarding to collect what only it holds. Once the web
onboarding exists and the settings panel writes those fields, **this should collapse into one store**
— the bot reading language, timezone and brief times from the API rather than its own SQLite. That is
the cleanup that makes the settings panel meaningful, and it is not done.

## Settings — what belongs there

Everything about the account, opened by clicking the user in the bottom-left rail. Mockup:
`design-mockup.html`.

- **Apariencia:** theme (light / dark / system), language.
- **Briefs:** morning and evening, each with a time and an on/off switch. Two maximum — the schema
  has exactly two slots, and the mockup states the limit rather than silently dropping a third.
- **Ubicación:** timezone. Changing it here must reschedule the bot's cron, not just store a string.
- **Categorías:** the user's own list.
- **Telegram:** **Conectar** with the step-by-step above, or **Conectado** with a Desconectar action.
  Not an assumed state — plenty of people will only ever use the web.
- One **Guardar** button, enabled only once something changed.

Every field maps to a column that already exists (`language`, `timezone`, `brief_morning`,
`brief_evening`, `categories`), so persisting this is wiring, not schema work — except that those
columns live in the bot's SQLite, which is the split described above.

## Categories: the two doors disagree today

Worth fixing before the web onboarding is written, because it is actively creating bad data.

- **Telegram never lets a task be uncategorised.** A code-level guard (`ADD_TASK_NEEDS_CATEGORY`)
  refuses the tool call when `tipo` is empty, so the model has to ask. It proposes one and waits.
- **The web assigns silently, and inconsistently.** The form defaults to `"Others"`, and the API
  falls back to `"Otros"` — two strings for one thing.

That split is visible in the data. The real vocabulary is Santiago's Spanish set, with English
strays from the web picker leaking in:

```
237 Otros · 108 Recruiting · 49 Finanzas · 30 Ayudantias · 27 Clases · 24 S3 · 18 Golf club
 6 Reader · 6 S.E.A. Advisors · 4 AI · 3 Personal · 3 University · 1 Estudios · 1 Job
 1 Networking · 1 Work · 1 Deportes · 1 convencimiento
```

(`convencimiento` is the mis-transcribed task from the 2026-08-26 handoff, still there.)

**Resolved 2026-09-02: Spanish is canonical, and English users get translated labels.**

The insight is that `tasks.tipo` holds an **identifier**, not display text. Conflating the two is what
made a second English list seem necessary in the first place. So:

- `src/lib/categories.ts` holds the one canonical set — mirroring the bot's `PRESET_CATEGORIES` —
  plus a label per language, and a reverse map so a form showing "Finances" still writes `Finanzas`.
- The English `ONBOARDING_SUGGESTED_TIPOS` list is retired.
- Every `"Others"` fallback became `"Otros"`, so the form and the API stop disagreeing about the name
  of the same category.
- Categories a user invents are never translated. Nobody expects the `Viajes` they typed to appear as
  "Travel".
- Interface language currently follows the browser; it moves into Settings once the preference store
  is unified.

**Still to do on the bot side:** its `PRESET_CATEGORIES` list is shown to the model as-is, so an
English-speaking user is offered Spanish names during onboarding. The same label layer belongs there,
with one hard rule for the prompt — *translate freely when talking to the user, but only ever send an
identifier to a tool*. The existing `CATEGORY INTEGRITY` rule and the `ADD_TASK_NEEDS_CATEGORY` guard
already back this up.

**A small cleanup awaits approval:** the stray English rows are all Santiago's own — `University` (3)
and `Job` (1) — plus one-offs `Deportes` and `convencimiento` (the mis-transcribed task from the
2026-08-26 handoff). Four or five rows, his data, his call on where they should land.

## Build order

1. ~~Telegram link flow~~ — **done**.
2. Settings panel in the web, writing to real storage. Needs the preference-store decision first.
3. Web onboarding at `/invite/<token>`, following `ONBOARDING.md`.
4. Invite records + the HTML email + the admin screen.
5. Collapse the two preference stores into one.
6. Category vocabulary decision and migration.

## Open questions for Santiago

- **Which category vocabulary wins?** Spanish is the safe answer given the data, but it is a product
  call, and it decides whether the English list gets retired.
- **What happens to the four orphan accounts** (Clemente, Rafael, Teresita, Cristian — plus Francisco
  and Brandon)? Invite them properly, or leave them?
- **Do briefs stay Telegram-only?** They are the strongest argument for connecting Telegram. Web push
  is possible later but far less reliable, especially on iOS.
- **Should the admin invite screen be in the dashboard at all**, or is `/invite` from Telegram enough?
