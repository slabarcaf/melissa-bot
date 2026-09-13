#!/bin/bash
# Deploy melissa-bot from GitHub to the hardened NON-ROOT runtime (/opt/melissa).
# Usage: /root/deploy-melissa.sh [branch]   (default: main)
set -e
BRANCH="${1:-main}"
REPO_DIR=/root/melissa-bot
DEST=/opt/melissa/whatsapp-bot
SKILLS=/opt/melissa/.openclaw/skills

if [ ! -d "$REPO_DIR/.git" ]; then
  GIT_SSH_COMMAND='ssh -i /root/.ssh/github_deploy' git clone git@github.com:slabarcaf/melissa-bot.git "$REPO_DIR"
fi
cd "$REPO_DIR"
GIT_SSH_COMMAND='ssh -i /root/.ssh/github_deploy' git fetch origin
git checkout "$BRANCH"
GIT_SSH_COMMAND='ssh -i /root/.ssh/github_deploy' git pull origin "$BRANCH"

# melissa.js -> whatsapp-bot.js (runtime entry); db/package alongside; the three
# MCP servers into skills. Until 2026-09-13 tasks-mcp.js and calendar-mcp.js were
# edited live on the VM and deliberately not overwritten here; they are in the
# repo now, so this script owns them like everything else.
cp -f melissa.js    "$DEST/whatsapp-bot.js"
cp -f db.js         "$DEST/db.js"
cp -f prefs.js      "$DEST/prefs.js"
cp -f package.json  "$DEST/package.json"
cp -f package-lock.json "$DEST/package-lock.json"
cp -f sheets-mcp.js   "$SKILLS/sheets-mcp.js"
# Los tres servidores MCP viven en el repo desde 2026-09-13. Dos de ellos existían
# solo aquí en la VM, editados a mano, con una copia espejo que había que mantener
# en paridad a pulso — sin versión, sin diff y sin vuelta atrás.
cp -f tasks-mcp.js    "$SKILLS/tasks-mcp.js"
cp -f calendar-mcp.js "$SKILLS/calendar-mcp.js"

# Every require() in whatsapp-bot.js must land here, or the service restarts
# into a MODULE_NOT_FOUND loop. Fail the deploy before touching systemd instead.
for f in whatsapp-bot.js db.js prefs.js package.json package-lock.json; do
  [ -f "$DEST/$f" ] || { echo "MISSING $DEST/$f — aborting before restart"; exit 1; }
done
for f in tasks-mcp.js calendar-mcp.js sheets-mcp.js; do
  [ -f "$SKILLS/$f" ] || { echo "MISSING $SKILLS/$f — aborting before restart"; exit 1; }
done

# Qué quedó desplegado, para que algo pueda comprobarlo después. El ritual del
# `md5sum` a mano que pide CLAUDE.md existe porque el archivo desplegado ya
# divergió del repo antes; un ritual que nadie corre no es una comprobación.
cat > "$DEST/DEPLOYED.json" <<JSON
{
  "commit":   "$(git -C "$REPO_DIR" rev-parse HEAD)",
  "branch":   "$BRANCH",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "checksums": {
    "whatsapp-bot.js":  "$(md5sum "$DEST/whatsapp-bot.js"   | cut -d' ' -f1)",
    "db.js":            "$(md5sum "$DEST/db.js"             | cut -d' ' -f1)",
    "prefs.js":         "$(md5sum "$DEST/prefs.js"          | cut -d' ' -f1)",
    "tasks-mcp.js":     "$(md5sum "$SKILLS/tasks-mcp.js"    | cut -d' ' -f1)",
    "calendar-mcp.js":  "$(md5sum "$SKILLS/calendar-mcp.js" | cut -d' ' -f1)",
    "sheets-mcp.js":    "$(md5sum "$SKILLS/sheets-mcp.js"   | cut -d' ' -f1)"
  }
}
JSON

# ── Compuertas, antes de tocar systemd ───────────────────────────────────────
# Las dos existían y funcionaban; este script simplemente nunca las llamaba, así
# que correrlas dependía de que alguien se acordara. El guardia de archivos
# faltantes de más arriba ya demostró que la forma correcta es abortar antes del
# restart, no descubrirlo después con el proceso viejo ya detenido.
echo "── pruebas unitarias ──"
( cd "$REPO_DIR" && npm test ) || { echo "TESTS FAILED — aborting before restart"; exit 1; }

cd "$DEST"
# `npm ci` respeta el lockfile exactamente; sin lockfile, cada despliegue resolvía
# a lo que hubiera publicado ese día y nadie lo había revisado. El `||` está para
# que un lockfile desincronizado no deje al servicio sin node_modules: en ese caso
# se instala como antes y el despliegue sigue, que es mejor que caerse aquí con el
# proceso viejo ya detenido.
npm ci --omit=dev || npm install --omit=dev
# hardened ownership + secret perms
chown -R melissa:melissa "$DEST" "$SKILLS"
chmod 600 "$DEST/config.json" "$DEST/melissa.db" 2>/dev/null || true

# SELFCHECK arranca todo menos el poller y sale 0/1, así que valida el
# despliegue nuevo mientras el servicio viejo sigue atendiendo. Si falla aquí,
# el bot que está corriendo sigue vivo y sin tocar.
echo "── selfcheck (no toca el poll en vivo) ──"
sudo -u melissa env SELFCHECK=1 \
  CFG_PATH="$DEST/config.json" DB_PATH="$DEST/melissa.db" CATS_PATH="$DEST/categories.json" \
  USAGE_LOG=/opt/melissa/.openclaw/usage/usage-log.jsonl USAGE_DIR=/opt/melissa/.openclaw/usage \
  PRIORITY_FILE=/opt/melissa/.openclaw/priority.json SKILLS_DIR="$SKILLS" \
  node "$DEST/whatsapp-bot.js" || { echo "SELFCHECK FAILED — aborting before restart"; exit 1; }

systemctl restart melissa-bot
sleep 3
systemctl is-active melissa-bot && echo "DEPLOY OK — $(git -C $REPO_DIR log -1 --oneline)"
journalctl -u melissa-bot -n 5 --no-pager
