#!/bin/bash
# Run on the Mac (home network) to install or update the Flex Rig handoff:
#  - Mac:       ~/.claude/skills/flex-rig/ (SKILL.md + flexrig.sh + repo-sync.sh)
#  - Flex Rig:  %USERPROFILE%\.flexrig\flexrig.mjs + serve.mjs + config.json + scheduled task "FlexRig Runner"
#               (runs as the PC user whether or not anyone is signed in)
#  - Flex Rig:  the test browser for tasks, in %USERPROFILE%\.flexrig\browser (browser-install.mjs: the pinned
#               Playwright browser tool, Playwright's own Chromium, and the "Flex Rig browser sign-in" desktop shortcut)
# Safe to run again. The scheduled task is only registered when it's missing, so updates just copy files.
# The whole setup (Code work bar, routing rule, repo sync job) is install.sh at the top of the repo, which runs this.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
CONFIG="${FLEXRIG_CONFIG:-$HOME/.flexrig/config}"
[ -f "$CONFIG" ] || { echo "No config at $CONFIG. Run install.sh from the top of the repo (it creates one)." >&2; exit 1; }
. "$CONFIG"
HOST="${FLEXRIG_HOST:?Set FLEXRIG_HOST in $CONFIG}"
REMOTE_HOME="${FLEXRIG_REMOTE_HOME:-C:\\Users\\${HOST%%@*}}"
REMOTE_REPOS="${FLEXRIG_REMOTE_REPOS:-$REMOTE_HOME\\Code}"
SSH=(ssh -o ConnectTimeout=8 -o BatchMode=yes -o LogLevel=ERROR "$HOST")

SKILL="$HOME/.claude/skills/flex-rig"
mkdir -p "$SKILL/logs"
# Replace each file atomically: copy to a temp file beside it, then mv into place. A running `flexrig.sh wait`
# (a chat waiting on Flex Rig) or repo-sync.sh reads its script while it runs; a plain cp would rewrite that file
# under it and bash would run garbled lines. mv swaps in a new file, and the running one keeps the old copy.
put() { # source, destination, [mode]
  local tmp="$2.tmp.$$"
  cp "$1" "$tmp" && { [ -z "${3:-}" ] || chmod "$3" "$tmp"; } && mv -f "$tmp" "$2" || { rm -f "$tmp"; return 1; }
}
put "$HERE/SKILL.md" "$SKILL/SKILL.md"
put "$HERE/flexrig.sh" "$SKILL/flexrig.sh" 755
put "$ROOT/mac/repo-sync.sh" "$SKILL/repo-sync.sh" 755
echo "Mac: skill installed in $SKILL"

"${SSH[@]}" 'New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.flexrig" | Out-Null'
scp -q -o ConnectTimeout=8 -o BatchMode=yes -o LogLevel=ERROR "$ROOT/runner/flexrig.mjs" "$HOST:.flexrig/flexrig.mjs"
scp -q -o ConnectTimeout=8 -o BatchMode=yes -o LogLevel=ERROR "$ROOT/runner/serve.mjs" "$HOST:.flexrig/serve.mjs"
# The runner reads where the repos live (and the default repo) from config.json beside it.
CJSON=$(jq -cn --arg repos "$REMOTE_REPOS" --arg def "${FLEXRIG_DEFAULT_REPO:-}" '{repos:$repos, defaultRepo:$def}' | base64 | tr -d '\n')
"${SSH[@]}" "\$b=[Convert]::FromBase64String('$CJSON'); [IO.File]::WriteAllBytes((Join-Path \$env:USERPROFILE '.flexrig\\config.json'), \$b)"

"${SSH[@]}" '
if (Get-ScheduledTask -TaskName "FlexRig Runner" -ErrorAction SilentlyContinue) { "Flex Rig: flexrig.mjs updated (FlexRig Runner task already there)"; exit 0 }
$node = (Get-Command node).Source
$mjs = "$env:USERPROFILE\.flexrig\flexrig.mjs"
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$mjs`" run" -WorkingDirectory "$env:USERPROFILE\.flexrig"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances Parallel -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
Register-ScheduledTask -TaskName "FlexRig Runner" -Action $action -Principal $principal -Settings $settings -Description "Runs coding tasks sent from the Mac (flex-rig)" -Force | Out-Null
"Flex Rig: flexrig.mjs + scheduled task FlexRig Runner installed"
' 2>&1 | grep -v -i -E 'post-quantum|store now|openssh.com/pq|may need to be upgraded'

# Test browser for Flex Rig tasks. The first run downloads Chromium (a few minutes); later runs take seconds.
# If it fails, everything above is still installed and tasks run as before, just without a browser.
if scp -q -o ConnectTimeout=8 -o BatchMode=yes -o LogLevel=ERROR "$ROOT/runner/browser-install.mjs" "$HOST:.flexrig/browser-install.mjs"; then
  "${SSH[@]}" 'node "$env:USERPROFILE\.flexrig\browser-install.mjs"' 2>&1 | grep -v -i -E 'post-quantum|store now|openssh.com/pq|may need to be upgraded' \
    || echo "Test browser: set-up had a problem (see the lines above). The rest of the handoff is installed."
else
  echo "Test browser: could not copy browser-install.mjs to Flex Rig. The rest of the handoff is installed."
fi
