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

# melissa.js -> whatsapp-bot.js (runtime entry); db/package alongside; sheets-mcp into skills.
# tasks-mcp.js / calendar-mcp.js are managed on the server (path-parameterized) and NOT overwritten.
cp -f melissa.js    "$DEST/whatsapp-bot.js"
cp -f db.js         "$DEST/db.js"
cp -f package.json  "$DEST/package.json"
cp -f sheets-mcp.js "$SKILLS/sheets-mcp.js"

cd "$DEST"
npm install --omit=dev
# hardened ownership + secret perms
chown -R melissa:melissa "$DEST" "$SKILLS"
chmod 600 "$DEST/config.json" "$DEST/melissa.db" 2>/dev/null || true

systemctl restart melissa-bot
sleep 3
systemctl is-active melissa-bot && echo "DEPLOY OK — $(git -C $REPO_DIR log -1 --oneline)"
journalctl -u melissa-bot -n 5 --no-pager
