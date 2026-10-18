#!/bin/bash
# Builds the isolated scratch pi environment: fake HOME, agent dir (settings, fake auth), demo git project.
# Nothing here reads or writes the real ~/.pi.
S="$1"   # scratch tui dir
mkdir -p "$S/agent" "$S/home/projects/acme-api"
cat > "$S/agent/settings.json" <<J
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-5-5", "packages": ["$REPO_ROOT"], "theme": "dark", "quietStartup": true, "collapseChangelog": true }
J
echo '{ "hud": { "enabled": true, "autoFetchMinutes": 0 }, "fleetWidget": false, "webHub": { "enabled": false }, "feishuNotify": { "enabled": false }, "memory": { "enabled": false }, "quota": { "enabled": false, "providers": "none" } }' > "$S/agent/pi-subagent.json"
echo '{"anthropic":{"type":"api_key","key":"sk-ant-demo-not-real"}}' > "$S/agent/auth.json"; chmod 600 "$S/agent/auth.json"
P="$S/home/projects/acme-api"
if [ ! -d "$P/.git" ]; then
  (cd "$P" && git init -q && git checkout -q -b feat/order-split && echo demo > README.md && git add . \
    && git -c user.name=demo -c user.email=demo@example.com commit -qm init)
fi
