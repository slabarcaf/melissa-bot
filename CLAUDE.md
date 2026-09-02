# melissa-bot

Multi-user Telegram assistant "Sydney". Node, long-polling, OpenAI tool-calling into MCP child processes. Runs on an Oracle VM.

## Read this first

**Before changing anything, read the most recent `HANDOFF-*.md` in this directory.** They are dated and sort newest-last:

```bash
ls HANDOFF-*.md | tail -1
```

That file is the source of truth for current status, the open defects, and the decisions not to relitigate. This file holds only the invariants that outlive any single handoff. `README.md` documents the features and config.

**For where the project is going**, read the newest `PLAN-*.md` — currently `PLAN-2026-09-01-producto.md`, the phased roadmap from Telegram-only assistant to multi-user product (accounts, web UI, PWA, per-user modules). The plan is the roadmap; the handoff is the state. Plans live here rather than in `~/.claude/plans/`, which is not durable — an earlier handoff already points at a plan file that no longer exists.

Do not add project status to this file. Status goes in a new dated handoff, so it never goes stale here.

## Invariants (violating these breaks production)

- **Production runs `main`.** Resolved 2026-09-01: `pause-morning-brief` was merged into `main`, the deploy script now defaults to `main`, and the stale branch is gone. Older handoffs say prod runs `pause-morning-brief` — that is history, not current state.
- **Always compare the repo against the VM before editing.** The deployed file has diverged from the repo before.
  ```bash
  ssh -i ~/.ssh/id_ed25519 opc@$VM_HOST 'sudo md5sum /opt/melissa/whatsapp-bot/whatsapp-bot.js'
  md5 -q melissa.js
  ```
  If they differ, reconcile first. Never overwrite `whatsapp-bot.js` with the local file blindly.
- **`melissa.js` in this repo deploys as `/opt/melissa/whatsapp-bot/whatsapp-bot.js`.** Different filename, same file.
- **`tasks-mcp.js` and `calendar-mcp.js` exist only on the VM** (`/opt/melissa/.openclaw/skills/`, mirrored in `/root/.openclaw/skills/`). They are not in this repo. Editing them means editing them on the VM, with a backup.
- **`config.json` is gitignored and lives only on the VM**, mode `0600`, owner `melissa`. It holds every credential. Any flag added there must be documented in `README.md`, or it becomes invisible from the repo.
- **Restart after every deploy:** `sudo systemctl restart melissa-bot`. Verify with `systemctl is-active`.
- **Only one process may poll the Telegram token at a time.** Two pollers silently steal each other's updates.
- **A commit whose author email is not a GitHub account will not deploy.** Vercel marks it `Blocked` — which looks like a usage limit, not a config error — and the deployment can never be released; you have to push a new commit with a valid author. Check `git config user.email` on any new machine before wondering why a push did nothing.
- **Per-user isolation is enforced by the API, not by this bot.** Since 2026-09-01 every task call carries `X-Telegram-Chat-Id`, the API resolves it to a `users` row, and Postgres scopes every query by `user_id`. The old `[uid:CHATID]` title-tag scheme and its ownership check were removed; do not reintroduce app-level filtering, and do not assume a task title carries any ownership information.
- **GitHub and Vercel are `slabarcaf`; Google Cloud and Neon are the Berkeley Google account.** The VM is Oracle, reached with `~/.ssh/id_ed25519`. Signing in to one identity is not enough — in particular the OAuth clients are under Berkeley while the deployment that uses them is under `slabarcaf`. The table in `README.md` says which holds what.
- **The Task Dashboard is the other half of this system and lives in a different repo.** Source: `~/demo/task-dashboard` → `github.com/slabarcaf/task-dashboard` (private). Next.js 14 + TypeScript + Tailwind on Vercel, Postgres on Neon. Live at `https://task-dashboard-nine-ashen.vercel.app`, which is `task_api_base` in the bot's `config.json`. It already has a web UI: Google sign-in, list and 6-column canvas views, filters, edit modal. The bot authenticates to it with a bearer token (`OPENCLAW_API_SECRET` there, `task_api_secret` here — same value, two names). **That token resolves every bot user to one owner account**, so all Telegram users currently share one task list, separated only by the `[uid:CHATID]` tag the bot writes into task titles.

## Reliability history (read before touching mutations or the voice path)

This codebase has a recurring class of bug: the model narrates an action it never performed. It has been fixed three times, and prompt-only fixes have failed twice. **Prefer a code-level guard over prompt text.** See the mutation-claim guard in `melissa.js` and the 2026-08-12 handoff.

An undescribed tool parameter is a code defect, not a prompt problem. The model treats an unlabeled free-text field as a dumping ground. See the 2026-08-26 handoff.

When production breaks right after a deploy: restart first to restore service, then **measure** the suspect before reverting it. Correlation with a deploy is not causation, and a same-day revert of an innocent change plants a false root cause for the next session.

## Cheat-sheet

```bash
ssh -i ~/.ssh/id_ed25519 opc@$VM_HOST
ssh -i ~/.ssh/id_ed25519 opc@$VM_HOST 'sudo /root/deploy-melissa.sh [branch]'
ssh -i ~/.ssh/id_ed25519 opc@$VM_HOST 'sudo journalctl -u melissa-bot -n 50 --no-pager'
npm test                  # syntax check + 41 unit tests on the pure helpers
                          # (parsers, name sanitising, Telegram HTML rendering).
                          # Run this plus SELFCHECK before every deploy.
```

Journald is not persistent on this VM. Logs vanish within hours, so capture anything you need while debugging.
