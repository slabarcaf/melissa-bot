# Melissa — Personal AI Assistant (Telegram)

Melissa is a personal AI assistant that lives in Telegram. She manages tasks, calendar events, and email — and delivers morning/evening briefings automatically every day.

**Telegram handle:** configured via `TELEGRAM_TOKEN` in `.env`

---

## Features

- **Natural language task management** — add, update, complete, and delete tasks by chatting. Tasks are persisted in a hosted task dashboard.
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
- **`tasks-mcp.js`** — MCP server wrapping the task dashboard REST API (list, add, update, delete tasks).
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

To deploy a code change:

```bash
# From local machine
scp -i ~/.ssh/id_ed25519 melissa.js opc@<VM_IP>:/tmp/melissa.js
ssh -i ~/.ssh/id_ed25519 opc@<VM_IP> "sudo cp /tmp/melissa.js /root/whatsapp-bot/whatsapp-bot.js && sudo node --check /root/whatsapp-bot/whatsapp-bot.js && sudo systemctl restart whatsapp-bot"
```

> **Note:** The production VM uses `config.json` instead of `.env`. The code supports both — if `TELEGRAM_TOKEN` is set in the environment, it uses env vars; otherwise it falls back to `config.json`.

---

## Task categories

Tasks are automatically categorized based on keywords:

| Category | Keywords |
|---|---|
| Golf club | golf, club, tee |
| Finance | payment, bank, transfer |
| Classes | class, homework, exam |
| Teaching | teaching assistant, grading |
| Recruiting | application, interview, cv |
| S3 | S3, startup |
| University | university, campus |
| Other | (default) |

---

## Cron schedule

| Time (PT) | Job |
|---|---|
| 7:00 AM daily | Morning briefing |
| 8:00 PM daily | Evening briefing |
| 2:00 AM daily | Health check |
