# Ops — production runtime (Oracle VM `openclaw`, $VM_HOST)

The bot runs as a **hardened non-root** systemd service. These files are the source of
truth for the server setup; keep them in sync with the VM.

## Layout
- Service user: `melissa` (uid 985, `/sbin/nologin`).
- Runtime: `/opt/melissa/whatsapp-bot/` — `whatsapp-bot.js` (deployed from repo `melissa.js`),
  `db.js`, `config.json` (secrets, `0600`), `melissa.db` (`0600`), `categories.json`, `node_modules`.
- MCP servers: `/opt/melissa/.openclaw/skills/` — `tasks-mcp.js`, `calendar-mcp.js`, `sheets-mcp.js`.
  (`tasks-mcp.js` on the VM has its `CATS_PATH`/`PRIORITY_FILE`/`USAGE_DIR` env-parameterized;
  `calendar-mcp.js` is already env-driven. These two are managed on the server, not deployed from
  this repo — only `sheets-mcp.js` is copied by the deploy script.)
- Git checkout used by the deploy script: `/root/melissa-bot/` (pulled via read-only deploy key
  `/root/.ssh/github_deploy`).

## Files here
- `melissa-bot.service` → install at `/etc/systemd/system/melissa-bot.service`.
  Sandboxed (ProtectSystem=strict, ProtectHome, PrivateTmp, NoNewPrivileges, ReadWritePaths=/opt/melissa,
  ProtectKernelTunables/ControlGroups, LockPersonality). Note: `RestrictSUIDSGID` was omitted — it needs
  systemd ≥ 242 and the VM runs 239.
- `deploy-melissa.sh` → install at `/root/deploy-melissa.sh`. Pulls a branch, copies
  `melissa.js`→`whatsapp-bot.js` + `db.js` + `package.json` + `sheets-mcp.js` into `/opt/melissa`,
  `npm install`, re-chowns to `melissa`, re-locks secrets to `0600`, restarts `melissa-bot`.

## Common commands
```bash
# deploy latest (default branch pause-morning-brief)
ssh -i ~/.ssh/id_ed25519 opc@$VM_HOST 'sudo /root/deploy-melissa.sh [branch]'
# logs
ssh -i ~/.ssh/id_ed25519 opc@$VM_HOST 'sudo journalctl -u melissa-bot -n 50 --no-pager'
# non-polling self-check (validate a deploy without touching the live poll)
sudo -u melissa env SELFCHECK=1 CFG_PATH=/opt/melissa/whatsapp-bot/config.json \
  DB_PATH=/opt/melissa/whatsapp-bot/melissa.db CATS_PATH=/opt/melissa/whatsapp-bot/categories.json \
  USAGE_LOG=/opt/melissa/.openclaw/usage/usage-log.jsonl USAGE_DIR=/opt/melissa/.openclaw/usage \
  PRIORITY_FILE=/opt/melissa/.openclaw/priority.json SKILLS_DIR=/opt/melissa/.openclaw/skills \
  node /opt/melissa/whatsapp-bot/whatsapp-bot.js
```

## Rollback to the old root service (retained until decommission)
The pre-migration root service `whatsapp-bot.service` is kept installed but **disabled**, and the
`/root/whatsapp-bot` tree is intact.
```bash
sudo systemctl disable --now melissa-bot
sudo systemctl enable --now whatsapp-bot
```
Caveat: only one may poll Telegram at a time; data written by `melissa-bot` since cutover lives in
`/opt/melissa` (not `/root`). Decommission the root service + `/root` tree once the non-root service
is confirmed stable.

## Logs

Persistentes desde 2026-09-13. `Storage=persistent` + `SystemMaxUse=200M` en
`/etc/systemd/journald.conf`, con `/var/log/journal` creado a mano. Antes de eso
journald era volátil en esta VM y los logs se borraban en horas, así que ningún
incidente dejaba rastro.

```bash
sudo journalctl -u melissa-bot --since "2 days ago" --no-pager
sudo journalctl --disk-usage
```

## Qué quedó desplegado

`ops/deploy-melissa.sh` escribe `/opt/melissa/whatsapp-bot/DEPLOYED.json` con el
commit y el md5 de cada archivo. Comparar contra el repo deja de ser un ritual
que hay que recordar:

```bash
ssh -i ~/.ssh/id_ed25519 opc@$VM_HOST 'sudo cat /opt/melissa/whatsapp-bot/DEPLOYED.json'
```
