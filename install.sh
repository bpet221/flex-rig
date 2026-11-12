#!/bin/bash
# Installs Flex Rig on the Mac, and its runner on the PC over SSH. Safe to run again (that is also how you update).
#   bash install.sh
# First run: it creates ~/.flexrig/config from flexrig.config.example and stops so you can edit it.
# Then run it again. It installs:
#  1. The Code work bar (a Claude Code mod): ~/.claude/mods/code-work, loaded in every chat through
#     CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json.
#  2. The routing rule: ~/.claude/rules/flex-rig.md (tells Claude to follow the bar).
#  3. The flex-rig skill (flexrig.sh, repo-sync.sh) in ~/.claude/skills/flex-rig, and the runner on the PC.
#  4. A LaunchAgent, com.flexrig.repo-sync: every 10 min it fast-forwards main in each repo in your repos folder,
#     refreshes the bar's model list, and about once a day updates the PC's Claude Code.
# Undo: launchctl bootout gui/$(id -u)/com.flexrig.repo-sync; rm ~/Library/LaunchAgents/com.flexrig.repo-sync.plist;
#       remove ~/.claude/mods/code-work from CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json;
#       rm -r ~/.claude/mods/code-work ~/.claude/skills/flex-rig ~/.claude/rules/flex-rig.md
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${FLEXRIG_CONFIG:-$HOME/.flexrig/config}"
MOD="$HOME/.claude/mods/code-work"

for tool in jq ssh scp rsync node git; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool. Install it first (on a Mac: brew install $tool)." >&2; exit 1; }
done

if [ ! -f "$CONFIG" ]; then
  mkdir -p "$(dirname "$CONFIG")"
  cp "$HERE/flexrig.config.example" "$CONFIG"
  echo "Created $CONFIG. Open it, fill in your PC's address and repo folders, then run this again."
  exit 1
fi
. "$CONFIG"
case "${FLEXRIG_HOST:-}" in ""|*your-windows-user*) echo "Edit FLEXRIG_HOST in $CONFIG first (it still has the example value), then run this again." >&2; exit 1 ;; esac

# 1. Mod
mkdir -p "$MOD"
rsync -a --delete --exclude tsconfig.json "$HERE/code-work/" "$MOD/"
/usr/bin/env node -e '
const fs = require("fs"), p = process.env.HOME + "/.claude/settings.json", dir = "~/.claude/mods/code-work";
const j = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
j.env = j.env || {};
const before = j.env.CLAUDE_CODE_PLUGIN_DIRS || "";
const list = before.split(":").filter(Boolean);
if (!list.includes(dir)) list.push(dir);
if (list.join(":") !== before) { j.env.CLAUDE_CODE_PLUGIN_DIRS = list.join(":"); fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n"); }'
echo "1/4 Code work bar installed in $MOD (shows in chats started from now on)"

# 2. Routing rule
mkdir -p "$HOME/.claude/rules"
cp "$HERE/mac/flex-rig-rule.md" "$HOME/.claude/rules/flex-rig.md.tmp.$$" && mv -f "$HOME/.claude/rules/flex-rig.md.tmp.$$" "$HOME/.claude/rules/flex-rig.md"   # whole file or none
echo "2/4 Routing rule installed: ~/.claude/rules/flex-rig.md"

# 3. Skill + runner on the PC
if bash "$HERE/skill/install.sh"; then echo "3/4 flex-rig skill + PC runner updated"
else echo "3/4 flex-rig skill updated on the Mac; the PC wasn't reachable, run this again when it is"; fi

# 4. Repo sync LaunchAgent
PLIST="$HOME/Library/LaunchAgents/com.flexrig.repo-sync.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.flexrig.repo-sync</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$HOME/.claude/skills/flex-rig/repo-sync.sh</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/flexrig-repo-sync.launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/flexrig-repo-sync.launchd.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/com.flexrig.repo-sync" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "4/4 Repo sync running every 10 min (log: ~/Library/Logs/flexrig-repo-sync.log)"
"$HOME/.claude/skills/flex-rig/flexrig.sh" models >/dev/null 2>&1 || true
echo "Done. Open a new chat to see the Code work bar (Mac ⟶ Flex Rig) above the prompt."
