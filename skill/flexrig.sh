#!/bin/bash
# Mac side of the Flex Rig handoff. Installed to ~/.claude/skills/flex-rig/flexrig.sh.
# Flex Rig runs its own `claude` (its own login).
#
#   flexrig.sh start --title "few words" [--model M] [--effort E] [--repo NAME] [--area PATH]... [--no-push] [--read] "task"
#                                                                 queue a coding task (own worktree + branch, opens a PR).
#                                                                 First pushes the user's local edits in --area (whole repo if none;
#                                                                 repos listed in FLEXRIG_AREA_REPOS need --area) plus commits not on GitHub to a new
#                                                                 branch mac/<stamp> (never main), and Flex Rig starts from it.
#                                                                 Model + effort come from the chat's Code work bar (the code-work mod
#                                                                 writes ~/.flexrig/chats/<chat>.bar.json): what the user picked there, else
#                                                                 what the chat itself uses. --model/--effort only when the user names one in
#                                                                 words (low, medium, high, xhigh, max; "default" = Flex Rig's own).
#   flexrig.sh say [RUN_ID] "message"                             steer the running task: Flex Rig's Claude reads it at its next step
#                                                                 (RUN_ID defaults to this chat's latest run)
#   flexrig.sh wait [RUN_ID] [--secs N]                           the usual way, in the FOREGROUND (Bash timeout 600000): keeps the
#                                                                 chat "working" for up to N s (default 150) with no replies, then
#                                                                 ONE progress line + "STILL WORKING" (call it again) or the report
#   flexrig.sh wait [RUN_ID] --until-done                         background variant (chat shows idle): silent until the run ends,
#                                                                 then only the final report. One waiter per run.
#   flexrig.sh models                                             newest model of each kind -> ~/.flexrig/models.json (for the bar)
#   flexrig.sh update-flexrig [--if-stale]                        update Flex Rig's Claude Code (repo-sync.sh runs it about once a day)
#   flexrig.sh merge RUN_ID|PR_URL                                merge the PR, delete its merged mac/ base branch, update the Mac folder
#                                                                 (given a run id, it also stops that run's preview)
#   flexrig.sh sync [REPO]                                        fast-forward the Mac's repo folder(s) to GitHub main, losing nothing
#   flexrig.sh outputs RUN_ID                                     copy the run's visuals (screenshots, images, HTML, PDFs) to ~/.flexrig/outputs/RUN_ID
#   flexrig.sh preview [RUN_ID]                                   open the app the task built: starts it on Flex Rig and prints a link that
#                                                                 works on this Mac (http://localhost:<port>, through an SSH tunnel). Run it
#                                                                 again to get the same link. The app stops by itself after 4 hours.
#                                                                 (RUN_ID defaults to this chat's latest run)
#   flexrig.sh preview stop [RUN_ID]                              close that link and stop the app on Flex Rig (safe to run twice)
#   flexrig.sh panel [RUN_ID] [AFTER]                             for the Flex Rig side panel (the code-work mod): one JSON line with Flex Rig's
#                                                                 newest runs and one run's conversation from log line AFTER on
#   flexrig.sh followup [--model M] [--effort E] [RUN_ID] "message"
#                                                                 continue that task once it's done (same Claude session; same branch,
#                                                                 or a new branch + PR when its PR was merged). Uses the bar's settings.
#   flexrig.sh watch RUN_ID                                       progress lines about once a minute, final report, then exits (for Monitor)
#   flexrig.sh status [RUN_ID]                                    one run's state, or the recent runs
#   flexrig.sh stop RUN_ID                                        stop a task
#   flexrig.sh cleanup                                            remove worktrees whose PR is merged/closed (both machines)
#   flexrig.sh takeover RUN_ID                                    finish a stuck task on the Mac (same branch, Flex Rig's work copied over)
#   flexrig.sh ask [--model M] [--effort E] [--resume SESSION] [--dir NAME] "question"
#                                                                 quick read-only question in the main checkout (waits for the answer);
#                                                                 effort matches this chat unless given
set -uo pipefail

# Settings live in one file (see flexrig.config.example in the repo). The installer creates it for you.
CONFIG="${FLEXRIG_CONFIG:-$HOME/.flexrig/config}"
[ -f "$CONFIG" ] || { echo "No config at $CONFIG. Copy flexrig.config.example there and edit it (see the README)." >&2; exit 1; }
. "$CONFIG"
HOST="${FLEXRIG_HOST:-}"
[[ "$HOST" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]] || { echo "Set FLEXRIG_HOST=\"user@address\" in $CONFIG." >&2; exit 1; }
REMOTE_USER="${HOST%%@*}"
REMOTE_HOME="${FLEXRIG_REMOTE_HOME:-C:\\Users\\$REMOTE_USER}"   # the PC user's home folder (a Windows path)
REMOTE_REPOS="${FLEXRIG_REMOTE_REPOS:-$REMOTE_HOME\\Code}"        # where the repos live on the PC
LOCAL_REPOS="${FLEXRIG_LOCAL_REPOS:-$HOME/Code}"                   # where the repos live on this Mac
DEFAULT_REPO="${FLEXRIG_DEFAULT_REPO:-}"                           # the repo a task goes to when --repo is not given
AREA_REPOS=":${FLEXRIG_AREA_REPOS:-}:"                             # repos where --area is required (big repos holding many apps)
MJS="$REMOTE_HOME\\.flexrig\\flexrig.mjs"
SSH_OPTS=(-o ConnectTimeout=8 -o BatchMode=yes -o ServerAliveInterval=30 -o LogLevel=ERROR)
SSH=(ssh "${SSH_OPTS[@]}" "$HOST")
ID_RE='^[0-9]{8}-[0-9]{4}-[0-9a-f]{4}$'
MACWT="$HOME/.flexrig/wt"   # Mac worktrees for tasks finished on the Mac

die() { echo "$*" >&2; exit 1; }
quiet_err() { grep -v -i -E 'post-quantum|store now|openssh.com/pq|may need to be upgraded' >&2 || true; }
remote() { "${SSH[@]}" "node '$MJS' $*" 2> >(quiet_err); }   # args must be safe tokens (ids, base64)
json_line() { grep -E '^[\[{]' | tail -1; }
b64() { base64 | tr -d '\n'; }
check_id() { [[ "${1:-}" =~ $ID_RE ]] || die "Give a run id like 20261108-1530-a1b2."; }

# Model + effort: Flex Rig matches the user's chat unless they name something else for the task.
# "default" = Flex Rig's own default. Claude Code tells commands it runs the chat's effort in CLAUDE_EFFORT.
EFFORT_RE='^(low|medium|high|xhigh|max)$'
check_model() { [ "$1" = default ] || [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || die "Bad --model: $1"; }
check_effort() { [ "$1" = default ] || [[ "$1" =~ $EFFORT_RE ]] || die "Bad --effort: $1 (use low, medium, high, xhigh, max or default)"; }
chat_effort() { if [[ "${CLAUDE_EFFORT:-}" =~ $EFFORT_RE ]]; then echo "$CLAUDE_EFFORT"; fi; }

# This chat: Claude Code tells commands it runs the chat's id. The code-work mod (the bar above the prompt)
# writes <chat>.bar.json; this script writes <chat>.json (its Flex Rig run) and <chat>.status.json (for the bar).
CHATS="$HOME/.flexrig/chats"; mkdir -p "$CHATS"
SESSION="${CLAUDE_CODE_SESSION_ID:-}"; [[ "$SESSION" =~ ^[A-Za-z0-9_-]+$ ]] || SESSION=""
bar() { [ -n "$SESSION" ] && [ -f "$CHATS/$SESSION.bar.json" ] && jq -r --arg k "$1" '.[$k] // empty' "$CHATS/$SESSION.bar.json" 2>/dev/null; return 0; }
chat_get() { [ -n "$SESSION" ] && [ -f "$CHATS/$SESSION.json" ] && jq -r --arg k "$1" '.[$k] // empty' "$CHATS/$SESSION.json" 2>/dev/null; return 0; }
remember_run() { # run-id title repo
  [ -n "$SESSION" ] || return 0
  jq -n --arg run "$1" --arg title "$2" --arg repo "$3" --arg at "$(date -u +%FT%TZ)" '{run:$run, title:$title, repo:$repo, startedAt:$at}' > "$CHATS/$SESSION.json"
  rm -f "$CHATS/$SESSION.status.json"
}
write_status() { # progress JSON -> what the bar shows under its buttons
  [ -n "$SESSION" ] || return 0
  echo "$1" | jq -c --arg title "$(chat_get title)" --arg at "$(date -u +%FT%TZ)" \
    '{run:.id, state, title:$title, elapsedMin, steps, lastTool, model, effort, steered, pr, updatedAt:$at}' > "$CHATS/$SESSION.status.json.tmp" 2>/dev/null \
    && mv "$CHATS/$SESSION.status.json.tmp" "$CHATS/$SESSION.status.json"
  local m; m=$(echo "$1" | jq -r '.model // empty')   # remember which model ids Flex Rig really ran (labels for the bar)
  [[ "$m" =~ ^claude-[a-z0-9-]+$ ]] && ! grep -qx "$m" "$HOME/.flexrig/models-seen.txt" 2>/dev/null && echo "$m" >> "$HOME/.flexrig/models-seen.txt"
  return 0
}
# Model + effort for new Flex Rig work: named in words (--model/--effort) > picked in the bar > what the chat uses.
pick_model() { # sets MODEL, MODEL_FROM; $1 = 1 when --model was given
  if [ "$1" = 1 ]; then MODEL_FROM="named for this task"
  elif [ -n "$(bar model)" ]; then MODEL=$(bar model); MODEL_FROM="picked in the bar"
  elif [ -n "$(bar chatModel)" ]; then MODEL=$(bar chatModel); MODEL_FROM="same as this chat"
  else return 1; fi
  check_model "$MODEL"; [ "$MODEL" != default ] || MODEL=""
}
pick_effort() { # sets EFFORT, EFFORT_FROM; $1 = 1 when --effort was given
  if [ "$1" = 1 ]; then check_effort "$EFFORT"; [ "$EFFORT" != default ] || EFFORT=""; EFFORT_FROM="named for this task"
  elif [[ "$(bar effort)" =~ $EFFORT_RE ]]; then EFFORT=$(bar effort); EFFORT_FROM="picked in the bar"
  else EFFORT=$(chat_effort); EFFORT_FROM="same as this chat"; fi
}

# The end of a run, for wait and watch.
final_report() { # progress JSON, run id
  echo "$1" | jq -r '
    "Flex Rig run \(.id) \(.state | ascii_upcase) after \(.elapsedMin) min, \(.steps) steps (\(.model // "default model"), effort \(.effort // "default")).",
    (if .pr then "PR: \(.pr) (\(.prState // "open"))" else "No PR." end),
    (if (.steered // 0) > 0 then "Steered by the user \(.steered) time(s) while it worked." else empty end),
    (if (.leftover // []) | length > 0 then "These messages arrived as it finished, so it never saw them. Send them now as a follow-up: \(.leftover | map("\"" + . + "\"") | join(" / "))" else empty end),
    (if .limit then "Its plan hit its usage limit. Offer to run this on the Mac instead." else empty end),
    (if .error then "Error: \(.error | tostring | .[0:600])" else empty end),
    (if (.denials|length) > 0 then "Blocked actions: \(.denials | join(", "))" else empty end),
    (if .result then "Flex Rig says:\n\(.result | tostring | .[0:1800])" else empty end),
    (if .browser == "throwaway" then "This run had a throwaway test browser with no saved sign-ins (another task or the sign-in window was using them)." else empty end),
    (if (.needsSignIn // []) | length > 0 then "NEEDS SIGN-IN in the Flex Rig test browser: \(.needsSignIn | join(", ")). Tell the user which site. They sign in themselves: open the PC over Remote Desktop, the \"Flex Rig browser sign-in\" shortcut on the desktop, sign in, close that window. Then send a follow-up." else empty end),
    (if .preview then "Preview available: flexrig.sh preview \(.id)" + (if (.preview.note // "") != "" then "  (\(.preview.note | tostring | .[0:200]))" else "" end) else empty end),
    "Follow up: flexrig.sh followup \(.id) \"...\""'
  if [ "$(echo "$1" | jq '.outputs | length')" != 0 ]; then
    fetch_outputs "$2" >/dev/null
    echo "Visuals from Flex Rig (copied to $OUTS/$2): $(cd "$OUTS/$2" && find . -type f | sed 's#^\./##' | sort | paste -sd, - | sed 's/,/, /g')"
    echo "Show them: images inline + SendUserFile, HTML pages as an Artifact (read them first), other files with SendUserFile."
  fi
}
progress_line() { # progress JSON -> one line
  echo "$1" | jq -r '"Flex Rig run \(.id): \(.state), \(.elapsedMin) min, \(.steps) steps" +
    (if .note then " (\(.note))" else "" end) +
    (if .lastTool then ". Last: \(.lastTool)" else "" end) +
    (if .lastText then ". \"\(.lastText | .[0:140])\"" else "" end)'
}

# Copy a run's outputs folder from Flex Rig. Prints one line per new file (local path), or nothing.
OUTS="$HOME/.flexrig/outputs"
fetch_outputs() {
  local id="$1" dest="$OUTS/$1"; mkdir -p "$dest"
  local before; before=$(cd "$dest" && find . -type f | sort)
  scp -q -r -o ConnectTimeout=8 -o BatchMode=yes -o LogLevel=ERROR "$HOST:.flexrig/runs/$id/outputs/*" "$dest/" 2>/dev/null || return 0
  (cd "$dest" && find . -type f | sort) | comm -13 <(echo "$before") - | sed "s#^\./#$dest/#"
}

# ---------- preview: the app a task built, opened on the Mac ----------
# The app listens on localhost on Flex Rig only. One background ssh per run forwards a Mac port to it (the tunnel).
# That ssh has a control socket, <id>.sock: it is how the tunnel is found again and closed. <id>.json remembers
# its pid and the Mac port.
PREVIEWS="$HOME/.flexrig/previews"
tunnel_sock() { echo "$PREVIEWS/$1.sock"; }
tunnel_alive() { [ -S "$(tunnel_sock "$1")" ] && ssh -S "$(tunnel_sock "$1")" -O check "$HOST" >/dev/null 2>&1; }
tunnel_pid() { ssh -S "$(tunnel_sock "$1")" -O check "$HOST" 2>&1 | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1; }   # "Master running (pid=123)"
port_free() { ! nc -z 127.0.0.1 "$1" >/dev/null 2>&1 && ! nc -z ::1 "$1" >/dev/null 2>&1; }   # nothing answers on this Mac port
tunnel_close() { # run id: 0 when a tunnel was closed, 1 when there was none. Quiet.
  local sock pid was=1; sock=$(tunnel_sock "$1")
  if tunnel_alive "$1"; then ssh -S "$sock" -O exit "$HOST" >/dev/null 2>&1; was=0; fi
  # Socket gone but that ssh still there: end it by the pid we remembered, only if it still is this run's tunnel.
  pid=$(jq -r '.pid // empty' "$PREVIEWS/$1.json" 2>/dev/null)
  if [[ "$pid" =~ ^[0-9]+$ ]] && ps -p "$pid" -o command= 2>/dev/null | grep -q -- "$1.sock"; then kill "$pid" 2>/dev/null && was=0; fi
  rm -f "$sock" "$PREVIEWS/$1.json"
  return $was
}
tunnel_open() { # run id, the app's port on Flex Rig: sets TUNNEL_PORT (the Mac port), or returns 1
  local sock p; sock=$(tunnel_sock "$1")
  mkdir -p "$PREVIEWS"; rm -f "$sock"
  # Same port number on the Mac when it is free, else the next ones. Everything goes to /dev/null so the
  # background ssh never holds this command's output open.
  for ((p = $2; p <= $2 + 20 && p <= 65535; p++)); do
    port_free "$p" || continue
    if ssh -f -N -M -S "$sock" -o ExitOnForwardFailure=yes "${SSH_OPTS[@]}" -L "$p:localhost:$2" "$HOST" </dev/null >/dev/null 2>&1; then
      TUNNEL_PORT="$p"; return 0
    fi
    port_free "$p" && return 1   # the port is still free, so the trouble is the connection itself
  done
  return 1
}
preview_stop() { # run id [quiet]: close this Mac's tunnel and stop the app on Flex Rig. Never fails; safe to run twice.
  local id="$1" quiet="${2:-}" closed=0 r app=""
  tunnel_close "$id" && closed=1
  r=$(remote preview-stop "$id" | json_line)
  [ -n "$r" ] && app=$(echo "$r" | jq -r 'if .ok == true then (if .stopped then "stopped" else "none" end) else "error" end' 2>/dev/null)
  case "$app" in
    stopped) echo "Preview of run $id stopped." ;;
    none) if [ $closed = 1 ]; then echo "Preview of run $id: link closed on this Mac (the app on Flex Rig had already stopped)."
          elif [ -z "$quiet" ]; then echo "No preview was running for run $id."; fi ;;
    error) echo "Preview of run $id: Flex Rig could not stop the app ($(echo "$r" | jq -r '.error // "no reason given"')). It stops by itself within 4 hours." ;;
    *) if [ $closed = 1 ]; then echo "Preview of run $id: link closed on this Mac. Flex Rig not reachable, so the app there stops by itself within 4 hours."
       elif [ -z "$quiet" ]; then echo "Flex Rig not reachable. No link was open on this Mac; an app still running there stops by itself within 4 hours."; fi ;;
  esac
  return 0
}

# ---------- push-first: Flex Rig starts from exactly what the user has on the Mac ----------
HERE="$(cd "$(dirname "$0")" && pwd)"
SYNC="$HERE/repo-sync.sh"                    # installed beside this script
PUSHLOG="$HOME/.flexrig/pushed.log"          # "<repo folder>\t<commit>\t<branch>"; repo-sync.sh reads it after merges
SECRET_NAME_RE='(^|/)(\.env(\.[^/]*)?|\.dev\.vars[^/]*|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*credentials[^/]*\.json|[^/]*secret[^/]*)$'
SAFE_NAME_RE='\.(example|sample|template)$'
SECRET_TEXT_RE='sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|shp(at|ss|ca)_[a-fA-F0-9]{32}|(sk|rk)_live_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

macdir() { echo "$LOCAL_REPOS/$1"; }
default_ref() { local r; r=$(git -C "$1" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); echo "${r:-origin/main}"; }

# Sets BASE: the branch Flex Rig starts from (empty = GitHub main). Prints one line saying what was pushed.
push_first() {
  local repo="$1"; shift
  local dir; dir=$(macdir "$repo")
  BASE=""
  if [ ! -d "$dir/.git" ]; then echo "No Mac folder for $repo: Flex Rig starts from GitHub main."; return 0; fi
  [ -x "$SYNC" ] && "$SYNC" "$dir" | sed 's/^/Mac folder: /'
  local T; T=$(mktemp -d "${TMPDIR:-/tmp}/flexrig-push.XXXXXX")
  local main; main=$(default_ref "$dir")
  local ps=("$@"); [ ${#ps[@]} -eq 0 ] && ps=(.)
  { git -C "$dir" diff --no-renames --name-only -z HEAD -- "${ps[@]}"; git -C "$dir" ls-files -z --others --exclude-standard -- "${ps[@]}"; } \
    | tr '\0' '\n' | sort -u > "$T/all"
  : > "$T/files"; : > "$T/skipped"
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if echo "$f" | grep -qiE "$SECRET_NAME_RE" && ! echo "$f" | grep -qiE "$SAFE_NAME_RE"; then echo "$f (looks like a secrets file)" >> "$T/skipped"; continue; fi
    if [ -f "$dir/$f" ] && [ "$(stat -f %z "$dir/$f")" -gt 20000000 ]; then echo "$f (over 20 MB)" >> "$T/skipped"; continue; fi
    echo "$f" >> "$T/files"
  done < "$T/all"
  local head; head=$(git -C "$dir" rev-parse HEAD)
  local unpushed; unpushed=$(git -C "$dir" rev-list --count HEAD --not --remotes=origin)
  local commit="$head" nfiles=0 tree
  if [ -s "$T/files" ]; then
    # Commit the edits with a throwaway index: the user's folder, index and branch stay exactly as they are.
    GIT_INDEX_FILE="$T/index" git -C "$dir" read-tree HEAD || { rm -rf "$T"; die "Couldn't read the Mac folder."; }
    tr '\n' '\0' < "$T/files" | GIT_INDEX_FILE="$T/index" git -C "$dir" add -A --pathspec-from-file=- --pathspec-file-nul \
      || { rm -rf "$T"; die "Couldn't collect the local edits."; }
    : > "$T/hits"
    while IFS= read -r f; do
      GIT_INDEX_FILE="$T/index" git -C "$dir" diff --cached -U0 HEAD -- "$f" | grep -E '^\+' | grep -qE "$SECRET_TEXT_RE" && echo "$f" >> "$T/hits"
    done < "$T/files"
    git -C "$dir" log -p -U0 --format= HEAD --not --remotes=origin | grep -E '^\+' | grep -qE "$SECRET_TEXT_RE" && echo "(a commit not on GitHub yet)" >> "$T/hits"
    if [ -s "$T/hits" ]; then
      local h; h=$(head -3 "$T/hits" | paste -sd, - | sed 's/,/, /g'); rm -rf "$T"
      die "Stopped before pushing: $h looks like it holds a secret key. Nothing pushed, Flex Rig not started. Tell the user (never show the key)."
    fi
    tree=$(GIT_INDEX_FILE="$T/index" git -C "$dir" write-tree)
    if [ "$tree" != "$(git -C "$dir" rev-parse "HEAD^{tree}")" ]; then
      nfiles=$(wc -l < "$T/files" | tr -d ' ')
      commit=$( { echo "the user's local edits from the Mac, pushed for a Flex Rig task"; echo
                  echo "They weren't on GitHub yet when the task started; the task builds on them."; echo
                  sed 's/^/- /' "$T/files" | head -40; } | git -C "$dir" commit-tree "$tree" -p "$head" ) \
        || { rm -rf "$T"; die "Couldn't save the local edits."; }
    fi
  elif [ "$unpushed" != 0 ]; then
    git -C "$dir" log -p -U0 --format= HEAD --not --remotes=origin | grep -E '^\+' | grep -qE "$SECRET_TEXT_RE" \
      && { rm -rf "$T"; die "Stopped before pushing: a commit not on GitHub yet looks like it holds a secret key. Nothing pushed, Flex Rig not started. Tell the user."; }
  fi
  local skipped=""; [ -s "$T/skipped" ] && skipped=" Left out: $(head -3 "$T/skipped" | paste -sd';' - | sed 's/;/; /g')."
  if [ "$commit" = "$head" ] && git -C "$dir" merge-base --is-ancestor "$head" "$main" 2>/dev/null; then
    rm -rf "$T"; echo "Nothing local to push: Flex Rig starts from GitHub main.$skipped"; return 0
  fi
  BASE="mac/$(date +%Y%m%d-%H%M)-$(openssl rand -hex 2)"
  if ! git -C "$dir" push -q origin "$commit:refs/heads/$BASE" 2> "$T/err"; then
    local e; e=$(tail -1 "$T/err"); rm -rf "$T"; die "Couldn't push the local edits to GitHub ($e). Flex Rig not started."
  fi
  printf '%s\t%s\t%s\n' "$dir" "$commit" "$BASE" >> "$PUSHLOG"
  local what="" cur; cur=$(git -C "$dir" branch --show-current)
  if [ "$nfiles" != 0 ]; then
    what="$nfiles edited file(s) ($(head -3 "$T/files" | sed 's#.*/##' | paste -sd, - | sed 's/,/, /g')$( [ "$nfiles" -gt 3 ] && echo ', ...'))"
  fi
  [ "$unpushed" != 0 ] && what="${what:+$what, plus }$unpushed commit(s) that weren't on GitHub"
  [ -z "$what" ] && what="the folder as it is"
  [ -n "$cur" ] && [ "origin/$cur" != "$main" ] && what="$what, from your branch $cur"
  echo "Pushed: $what to GitHub branch $BASE (not main). Flex Rig starts from there.$skipped"
  rm -rf "$T"
}

# Mac folder for a GitHub PR link: the folder under your repos folder whose origin is that repo.
dir_for_url() {
  local slug d u; slug=$(echo "$1" | sed -E 's#https://github.com/([^/]+/[^/]+)/pull/.*#\1#' | tr 'A-Z' 'a-z')
  for d in "$LOCAL_REPOS"/*/; do
    d="${d%/}"; [ -e "$d/.git" ] || continue
    u=$(git -C "$d" remote get-url origin 2>/dev/null | tr 'A-Z' 'a-z' | sed -E 's#\.git$##; s#^git@github.com:#https://github.com/#')
    [ "$u" = "https://github.com/$slug" ] && { echo "$d"; return 0; }   # first match wins
  done
}

cmd="${1:-}"; shift || true
case "$cmd" in
  start)
    REPO="$DEFAULT_REPO"; MODEL=""; MODEL_SET=0; EFFORT=""; EFFORT_SET=0; MODE="work"; PUSH=1; AREAS=(); TITLE=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --repo) REPO="$2"; shift 2 ;;
        --title) TITLE="$2"; shift 2 ;;
        --model) MODEL="$2"; MODEL_SET=1; shift 2 ;;
        --effort) EFFORT="$2"; EFFORT_SET=1; shift 2 ;;
        --read) MODE="read"; shift ;;
        --area) AREAS+=("$2"); shift 2 ;;
        --no-push) PUSH=0; shift ;;
        --) shift; break ;;
        -*) die "Unknown option: $1" ;;
        *) break ;;
      esac
    done
    TASK="${*:-}"; [ -n "$TASK" ] || die "Give the task as the last argument."
    [ -n "$REPO" ] || die "Name the repo with --repo NAME (or set FLEXRIG_DEFAULT_REPO in $CONFIG)."
    [[ "$REPO" =~ ^[A-Za-z0-9\ ._-]+$ ]] || die "Bad --repo"
    pick_model $MODEL_SET || die "This chat has no Code work bar settings yet (the code-work mod isn't loaded here): add --model with this chat's exact model id (e.g. --model claude-opus-5-5). Nothing pushed."
    pick_effort $EFFORT_SET
    [ -n "$TITLE" ] || TITLE=$(printf '%s' "$TASK" | head -1 | cut -c1-60)
    BASE=""
    if [ "$MODE" = work ] && [ $PUSH = 1 ]; then
      if [[ "$AREA_REPOS" == *":$REPO:"* ]] && [ ${#AREAS[@]} -eq 0 ]; then
        die "$REPO holds many apps: add --area <folder> (the folder the task works in) so only those local edits ride along, or --no-push."
      fi
      L=$(remote list | json_line)
      [ -n "$L" ] || die "Flex Rig not reachable over SSH (home network only, PC must be on). Nothing pushed."
      push_first "$REPO" ${AREAS[@]+"${AREAS[@]}"}
    fi
    REQ=$(jq -cn --arg task "$TASK" --arg repo "$REPO" --arg model "$MODEL" --arg effort "$EFFORT" --arg mode "$MODE" --arg base "$BASE" \
      '{task:$task, repo:$repo, mode:$mode} + (if $model=="" then {} else {model:$model} end) + (if $effort=="" then {} else {effort:$effort} end) + (if $base=="" then {} else {base:$base} end)' | b64)
    R=$(remote submit "$REQ" | json_line)
    [ -n "$R" ] || die "Flex Rig not reachable over SSH (home network only, PC must be on).${BASE:+ Your edits are on GitHub branch $BASE.}"
    echo "$R" | jq -e .ok >/dev/null || die "Flex Rig refused: $(echo "$R" | jq -r .error)"
    remember_run "$(echo "$R" | jq -r .id)" "$TITLE" "$REPO"
    echo "$R" | jq -r --arg mf "$MODEL_FROM" --arg ef "$EFFORT_FROM" '"Started on Flex Rig: run \(.id) (\(.mode)) in \(.repo), branch \(.branch)" + (if .base then " (from \(.base))" else "" end) +
      "\nRuns with: \(.model // "Flex Rig'"'"'s default model") (\($mf)), effort \(.effort // "default") (\($ef))" +
      "\nKeep this chat working until it is done: flexrig.sh wait \(.id)  (foreground, Bash timeout 600000; 2.5 min per call, repeat while it says STILL WORKING)"'
    ;;

  say)
    ID=""; if [[ "${1:-}" =~ $ID_RE ]]; then ID="$1"; shift; else ID=$(chat_get run); fi
    [ -n "$ID" ] || die "No Flex Rig run for this chat yet: give a run id."
    MSG="${*:-}"; [ -n "$MSG" ] || die "Give the message."
    [ ${#MSG} -le 15000 ] || die "Message too long (15,000 characters max): shorten it or send it as a follow-up."
    R=$(remote say "$ID" "$(printf '%s' "$MSG" | b64)" | json_line)
    [ -n "$R" ] || die "Flex Rig not reachable right now (home network only), so it wasn't sent. Try again at the next check-in, or send it as a follow-up later."
    if echo "$R" | jq -e '.ok == true' >/dev/null; then echo "Sent to Flex Rig (run $ID): it reads it at its next step."
    elif echo "$R" | jq -e '.finished == true' >/dev/null; then echo "Run $ID already finished, so it wasn't steered. Send it as a follow-up instead: flexrig.sh followup $ID \"...\""; exit 3
    else die "Flex Rig refused: $(echo "$R" | jq -r .error)"; fi
    ;;

  wait)
    # The usual way, in the foreground: keeps this chat "working" (the app and the bar show it) while Flex Rig works,
    # so the user's messages arrive mid-work (and can be passed on with `say`) and the app holds their queued messages
    # until the run is done. One call lasts up to --secs (default 150 = 2.5 min, so ~24 chat replies an hour instead of
    # ~60: each reply re-sends the whole chat). Polls every 20 s, keeps the bar's status line current, and prints
    # only at the end: the final report, or ONE progress line + STILL WORKING. Run it with Bash timeout 600000.
    ID=""; SECS=150; UNTIL_DONE=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --secs) SECS="$2"; shift 2 ;;
        --until-done|--background) UNTIL_DONE=1; shift ;;
        *) [[ "$1" =~ $ID_RE ]] || die "Unknown option: $1"; ID="$1"; shift ;;
      esac
    done
    [ -n "$ID" ] || ID=$(chat_get run); check_id "$ID"
    if [ $UNTIL_DONE = 1 ]; then
      # Opt-in background variant, for a run nobody needs to steer or see as working (the user stepping away): the
      # chat makes no replies at all, but the app shows it idle. Prints nothing until the run ends, then only the
      # final report, which wakes the chat once. The user steers meanwhile from the side panel, or by typing (then `say`).
      LOCK="$CHATS/waiter-$ID.pid"
      if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
        echo "Already waiting on Flex Rig run $ID in the background: nothing to do. Its report comes when the run ends."; exit 0
      fi
      echo $$ > "$LOCK"; trap 'rm -f "$LOCK"' EXIT
      lastout="[]"; fails=0
      while :; do
        P=$(remote progress "$ID" | json_line)
        if [ -n "$P" ] && echo "$P" | jq -e '.state' >/dev/null 2>&1; then
          fails=0
          [ "$(chat_get run)" = "$ID" ] && write_status "$P"
          case "$(echo "$P" | jq -r .state)" in
            done|failed|stopped) final_report "$P" "$ID"; exit 0 ;;
          esac
          okey=$(echo "$P" | jq -c '[.outputs[]? | [.name, .size, .mtime]]')
          if [ "$okey" != "[]" ] && [ "$okey" != "$lastout" ]; then fetch_outputs "$ID" >/dev/null; lastout="$okey"; fi
          sleep 30
        elif [ -n "$P" ]; then
          echo "Flex Rig run $ID: $(echo "$P" | jq -r '.error // "unknown error"')"; exit 1
        else
          # Unreachable (Mac asleep or away from home): keep quiet and keep trying; the run goes on over there.
          # Only after 6 hours without contact does it wake the chat to say so.
          fails=$((fails+1))
          [ $fails -ge 360 ] && { echo "Flex Rig run $ID: no contact with Flex Rig for 6 hours. Check later with flexrig.sh status $ID."; exit 1; }
          sleep 60
        fi
      done
    fi
    [[ "$SECS" =~ ^[0-9]+$ ]] && [ "$SECS" -le 540 ] || die "--secs must be 0-540"
    END=$(( $(date +%s) + SECS )); last=""; reached=0
    while :; do
      P=$(remote progress "$ID" | json_line)
      if [ -n "$P" ] && echo "$P" | jq -e '.state' >/dev/null 2>&1; then
        reached=1; write_status "$P"
        case "$(echo "$P" | jq -r .state)" in
          done|failed|stopped) final_report "$P" "$ID"; exit 0 ;;
        esac
        last=$(progress_line "$P")   # printed once at the end: a short tool result keeps each check cheap
      elif [ -n "$P" ]; then
        echo "Flex Rig run $ID: $(echo "$P" | jq -r '.error // "unknown error"')"; exit 1
      fi
      [ "$(date +%s)" -ge "$END" ] && break
      sleep 20
    done
    [ -n "$last" ] && echo "$last"
    [ $reached = 0 ] && echo "Can't reach Flex Rig right now (Mac away from home or asleep?). The run keeps going there."
    echo "STILL WORKING (run $ID): call flexrig.sh wait $ID again (foreground, Bash timeout 600000) to keep this chat working."
    ;;

  models)
    # Newest model of each kind, for the bar's menu. Free: read from Claude Code's own records on this Mac
    # (~/.claude.json) and from what Flex Rig reported running. Opus/Sonnet/Haiku are sent by kind ("opus"),
    # which Claude Code always turns into the newest; Fable by its newest id, once Claude's own list offers Fable.
    mkdir -p "$HOME/.flexrig"
    node - "$HOME/.claude.json" "$HOME/.flexrig/models-seen.txt" > "$HOME/.flexrig/models.json.tmp" <<'NODE' && mv "$HOME/.flexrig/models.json.tmp" "$HOME/.flexrig/models.json"
const fs = require('fs');
const [cfgFile, seenFile] = process.argv.slice(2);
const ids = new Set(); let offered = [];
try {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  offered = (cfg.additionalModelOptionsCache || []).map((o) => String(o.value || '').replace(/\[.*\]$/, ''));
  const walk = (o, d) => { if (d > 6 || !o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { for (const s of [k, typeof v === 'string' ? v : '']) (s.match(/claude-(fable|opus|sonnet|haiku)-[0-9][0-9a-z-]*/g) || []).forEach((x) => ids.add(x)); walk(v, d + 1); } };
  walk(cfg, 0);
} catch {}
try { fs.readFileSync(seenFile, 'utf8').split('\n').forEach((l) => /^claude-[a-z0-9-]+$/.test(l.trim()) && ids.add(l.trim())); } catch {}
offered.forEach((x) => /^claude-[a-z0-9-]+$/.test(x) && ids.add(x));
const ver = (id, fam) => id.slice(`claude-${fam}-`.length).replace(/-\d{8}$/, '').split('-').filter((p) => /^\d+$/.test(p)).map(Number);
const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0; } return false; };
const NAMES = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const models = [];
for (const fam of Object.keys(NAMES)) {
  let best = null, bv = [];
  for (const id of ids) if (id.startsWith(`claude-${fam}-`)) { const v = ver(id, fam); if (v.length && (!best || newer(v, bv))) { best = id; bv = v; } }
  const label = best ? `${NAMES[fam]} ${bv.join('.')}` : NAMES[fam];
  // Fable shows only if Claude's model list offers it (the account has it), at the newest version seen:
  // that list is a cache that can lag a release (it said 5.1 for hours after Fable 5.2 came out).
  if (fam === 'fable') { const o = offered.find((x) => x.startsWith('claude-fable-')); const pick = o && best && newer(bv, ver(o, fam)) ? best : o; if (pick) models.push({ family: fam, value: pick, label: `${NAMES[fam]} ${ver(pick, fam).join('.')}` }); continue; }
  models.push({ family: fam, value: fam, label, id: best });
}
process.stdout.write(JSON.stringify({ updatedAt: new Date().toISOString(), models }, null, 1) + '\n');
NODE
    jq -r '.models[] | "\(.label)  (sent as \(.value))"' "$HOME/.flexrig/models.json"
    ;;

  update-flexrig)
    STAMP="$HOME/.flexrig/flexrig-updated"
    if [ "${1:-}" = --if-stale ] && [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -f %m "$STAMP") )) -lt 72000 ]; then exit 0; fi
    R=$(remote update | json_line); [ -n "$R" ] || { echo "Flex Rig not reachable; will try again later."; exit 0; }
    echo "$R" | jq -r 'if .ok then "Flex Rig Claude Code: \(.before) -> \(.after)" + (if .updated then " (updated)" else " (already newest)" end) else "Skipped: \(.skipped // .error)" end'
    echo "$R" | jq -e '.ok == true' >/dev/null && touch "$STAMP"
    ;;

  merge)
    # Merge the task's PR, delete merged mac/ base branches, then fast-forward the Mac folder.
    ARG="${1:-}"; [ -n "$ARG" ] || die "Give a run id or a PR link."
    URL=""; DIR=""
    if [[ "$ARG" =~ $ID_RE ]]; then
      P=$(remote progress "$ARG" | json_line); [ -n "$P" ] || die "Flex Rig not reachable: give the PR link instead."
      URL=$(echo "$P" | jq -r '.pr // empty'); DIR=$(macdir "$(echo "$P" | jq -r .repo)")
    else URL="$ARG"; fi
    [[ "$URL" =~ ^https://github\.com/[^/]+/[^/]+/pull/[0-9]+$ ]] || die "No PR to merge${URL:+ ($URL)}."
    [ -n "$DIR" ] || DIR=$(dir_for_url "$URL")
    STATE=$(cd "$HOME" && gh pr view "$URL" --json state --jq .state) || die "Couldn't read $URL"
    case "$STATE" in
      OPEN) (cd "$HOME" && gh pr merge "$URL" --merge --delete-branch >/dev/null 2>&1) || die "GitHub wouldn't merge $URL (conflicts or checks?)."
            echo "Merged: $URL" ;;
      MERGED) echo "Already merged: $URL" ;;
      *) die "$URL is $STATE, not merged." ;;
    esac
    # Merged, so the run's preview is over: close this Mac's link and stop the app on Flex Rig. Never fails the merge.
    # (Given a PR link there is no run id here: Flex Rig stops the app itself when it removes the merged worktree.)
    if [[ "$ARG" =~ $ID_RE ]]; then preview_stop "$ARG" quiet || true; fi
    if [ -n "$DIR" ] && [ -d "$DIR/.git" ]; then
      git -C "$DIR" fetch -q origin
      MAIN=$(default_ref "$DIR")
      if [ -f "$PUSHLOG" ]; then
        awk -F'\t' -v d="$DIR" '$1==d && $3 ~ /^mac\// {print $2"\t"$3}' "$PUSHLOG" | while IFS=$'\t' read -r C B; do
          if git -C "$DIR" ls-remote --exit-code -q origin "refs/heads/$B" >/dev/null 2>&1 && git -C "$DIR" merge-base --is-ancestor "$C" "$MAIN" 2>/dev/null; then
            git -C "$DIR" push -q origin --delete "$B" 2>/dev/null && echo "Deleted merged branch $B on GitHub."
          fi
        done
      fi
      "$SYNC" "$DIR" | sed 's/^/Mac folder: /'
    else
      echo "No Mac folder found for $URL; the background sync will pick it up if there is one."
    fi
    ;;

  outputs)
    ID="${1:-}"; check_id "$ID"
    fetch_outputs "$ID" >/dev/null
    if [ -d "$OUTS/$ID" ] && [ -n "$(find "$OUTS/$ID" -type f | head -1)" ]; then find "$OUTS/$ID" -type f | sort
    else echo "No visuals from run $ID."; fi ;;

  preview)
    # Open the app a task built. Flex Rig starts it (kept for 4 hours, localhost only); this Mac reaches it
    # through an SSH tunnel and gets a http://localhost link. Running it again gives the same link.
    SUB=""; if [ "${1:-}" = stop ]; then SUB=stop; shift; fi
    ID=""; if [[ "${1:-}" =~ $ID_RE ]]; then ID="$1"; elif [ -z "${1:-}" ]; then ID=$(chat_get run); else die "Give a run id like 20261108-1530-a1b2."; fi
    [ -n "$ID" ] || die "No Flex Rig run for this chat yet: give a run id."
    if [ "$SUB" = stop ]; then preview_stop "$ID"; exit 0; fi
    R=$(remote preview-start "$ID" | json_line)
    [ -n "$R" ] || die "Flex Rig not reachable over SSH (home network only, PC must be on)."
    echo "$R" | jq -e '.ok == true' >/dev/null 2>&1 || die "No preview: $(echo "$R" | jq -r '.error // "Flex Rig gave no reason"')"
    PORT=$(echo "$R" | jq -r '.port'); NOTE=$(echo "$R" | jq -r '.note // "" | tostring | .[0:200]')
    [[ "$PORT" =~ ^[0-9]+$ ]] || die "No preview: Flex Rig did not say which port the app is on."
    F="$PREVIEWS/$ID.json"; MACPORT=""
    # A tunnel from an earlier call that is still up, and still points at this port: use it.
    if tunnel_alive "$ID" && [ "$(jq -r '.port // empty' "$F" 2>/dev/null)" = "$PORT" ]; then MACPORT=$(jq -r '.macPort // empty' "$F" 2>/dev/null); fi
    if ! [[ "$MACPORT" =~ ^[0-9]+$ ]]; then
      tunnel_close "$ID"
      TUNNEL_PORT=""
      tunnel_open "$ID" "$PORT" || die "The app is running on Flex Rig, but this Mac could not open the link to it (SSH tunnel to port $PORT). Try again, or stop the app with: flexrig.sh preview stop $ID"
      MACPORT="$TUNNEL_PORT"
      jq -n --arg id "$ID" --arg pid "$(tunnel_pid "$ID")" --argjson macPort "$MACPORT" --argjson port "$PORT" --arg note "$NOTE" --arg at "$(date -u +%FT%TZ)" \
        '{id:$id, pid:($pid | tonumber? // null), macPort:$macPort, port:$port, note:$note, openedAt:$at}' > "$F"
    fi
    # The app was answering on Flex Rig when it started; make sure it also answers through the tunnel.
    up=0; for _ in 1 2 3 4 5; do curl -s -o /dev/null -m 3 "http://localhost:$MACPORT/" && { up=1; break; }; sleep 1; done
    [ $up = 1 ] || echo "Nothing answered at http://localhost:$MACPORT yet. The app may still be starting: try the link in a moment." >&2
    echo "Preview: http://localhost:$MACPORT${NOTE:+  ($NOTE)}  Stop it with: flexrig.sh preview stop $ID"
    ;;

  sync)
    if [ -n "${1:-}" ]; then "$SYNC" "$1"; else for d in "$LOCAL_REPOS"/*/; do d="${d%/}"; [ -e "$d/.git" ] && "$SYNC" "$d"; done; fi ;;

  followup)
    # Uses what the bar shows now (named in words > picked in the bar > what the chat uses).
    MODEL=""; MODEL_SET=0; EFFORT=""; EFFORT_SET=0; TITLE=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --model) MODEL="$2"; MODEL_SET=1; shift 2 ;;
        --effort) EFFORT="$2"; EFFORT_SET=1; shift 2 ;;
        --title) TITLE="$2"; shift 2 ;;
        *) break ;;
      esac
    done
    if [[ "${1:-}" =~ $ID_RE ]]; then ID="$1"; shift; else ID=$(chat_get run); fi
    check_id "$ID"
    MSG="${*:-}"; [ -n "$MSG" ] || die "Give the follow-up message."
    pick_model $MODEL_SET || { MODEL=""; MODEL_FROM="same as before"; }
    pick_effort $EFFORT_SET
    [ -n "$TITLE" ] || TITLE=$(chat_get title); [ -n "$TITLE" ] || TITLE=$(printf '%s' "$MSG" | head -1 | cut -c1-60)
    REQ=$(jq -cn --arg task "$MSG" --arg f "$ID" --arg model "$MODEL" --arg effort "$EFFORT" \
      '{task:$task, followup_of:$f} + (if $model=="" then {} else {model:$model} end) + (if $effort=="" then {} else {effort:$effort} end)' | b64)
    R=$(remote submit "$REQ" | json_line)
    [ -n "$R" ] || die "Flex Rig not reachable over SSH (home network only, PC must be on)."
    echo "$R" | jq -e .ok >/dev/null || die "Flex Rig refused: $(echo "$R" | jq -r .error)"
    remember_run "$(echo "$R" | jq -r .id)" "$TITLE" "$(echo "$R" | jq -r .repo)"
    echo "$R" | jq -r --arg mf "$MODEL_FROM" --arg ef "$EFFORT_FROM" '"Follow-up started on Flex Rig: run \(.id), " +
      (if .prevPr then "new branch \(.branch) fresh from main (the earlier PR is \(.prevPr | sub("^.* \\("; "") | sub("\\)$"; ""))), so it opens a new PR" else "same branch \(.branch)" end) +
      "\nRuns with: \(.model // "Flex Rig'"'"'s default model") (\($mf)), effort \(.effort // "default") (\($ef))" +
      "\nKeep this chat working until it is done: flexrig.sh wait \(.id)  (foreground, Bash timeout 600000; 2.5 min per call, repeat while it says STILL WORKING)"'
    ;;

  watch)
    # One stdout line = one notification. Prints only when something changed, about once a minute.
    # Survives the Mac sleeping: it just picks up where Flex Rig is when it wakes.
    ID="${1:-}"; check_id "$ID"
    last=""; lastout="[]"; down=0; fails=0
    while true; do
      P=$(remote progress "$ID" | json_line)
      if [ -z "$P" ]; then
        fails=$((fails+1))
        if [ $down = 0 ] && [ $fails -ge 2 ]; then echo "Flex Rig run $ID: can't reach Flex Rig right now (Mac asleep or away from home?). The task keeps running there; I'll catch up when it's reachable."; down=1; fi
        sleep 60; continue
      fi
      fails=0
      if ! echo "$P" | jq -e '.state' >/dev/null 2>&1; then echo "Flex Rig run $ID: $(echo "$P" | jq -r '.error // "unknown error"')"; exit 1; fi
      [ $down = 1 ] && { echo "Flex Rig run $ID: reachable again."; down=0; }
      [ "$(chat_get run)" = "$ID" ] && write_status "$P"
      state=$(echo "$P" | jq -r .state)
      case "$state" in
        done|failed|stopped)
          final_report "$P" "$ID"
          exit 0 ;;
        *)
          line=$(progress_line "$P")
          key=$(echo "$P" | jq -r '"\(.state)|\(.steps)|\(.lastTool)|\(.note)"')
          if [ "$key" != "$last" ]; then echo "$line"; last="$key"; fi
          okey=$(echo "$P" | jq -c '[.outputs[]? | [.name, .size, .mtime]]')
          if [ "$okey" != "[]" ] && [ "$okey" != "$lastout" ]; then
            new=$(fetch_outputs "$ID"); lastout="$okey"
            [ -n "$new" ] && echo "Flex Rig run $ID: new visuals copied to the Mac: $(echo "$new" | paste -sd, - | sed 's/,/, /g')"
          fi ;;
      esac
      sleep 60
    done
    ;;

  panel)
    # For the Flex Rig side panel in the Claude app (the code-work mod). No run id = the run that is working,
    # else the newest. Always prints one JSON line, also when Flex Rig can't be reached.
    ID="-"; if [[ "${1:-}" =~ $ID_RE ]]; then ID="$1"; shift; fi
    AFTER="${1:-0}"; [[ "$AFTER" =~ ^[0-9]+$ ]] || AFTER=0
    R=$(remote panel "$ID" "$AFTER" | json_line)
    if [ -z "$R" ]; then echo '{"ok":false,"error":"Flex Rig not reachable"}'; exit 1; fi
    echo "$R"
    ;;

  status)
    if [ -n "${1:-}" ]; then
      check_id "$1"
      P=$(remote progress "$1" | json_line); [ -n "$P" ] || die "Flex Rig not reachable."
      echo "$P" | jq .
    else
      L=$(remote list | json_line); [ -n "$L" ] || die "Flex Rig not reachable."
      echo "$L" | jq -r '.[] | "\(.id)  \(.state)  \(.repo)  \(.pr // "-")  \(.task)"'
    fi
    ;;

  stop)
    check_id "${1:-}"; remote stop "$1" | json_line | jq -r 'if .ok then "Stopped run \(.id) (was \(.was))." else "Error: \(.error)" end' ;;

  cleanup)
    R=$(remote cleanup | json_line)
    if [ -n "$R" ]; then
      echo "$R" | jq -r '"Flex Rig removed: \(.removed | map("\(.chain) (\(.why))") | join(", ") | if .=="" then "none" else . end)",
                         "Flex Rig kept: \(.kept | map("\(.chain) (\(.why))") | join(", ") | if .=="" then "none" else . end)"'
    else echo "Flex Rig not reachable; cleaning the Mac only."; fi
    # Mac takeover worktrees: remove once their PR is merged or closed.
    for d in "$MACWT"/*/; do
      [ -d "$d" ] || continue
      d="${d%/}"; br=$(git -C "$d" branch --show-current 2>/dev/null) || continue
      st=$(cd "$d" && gh pr list --head "$br" --state all --json state --jq '.[0].state' 2>/dev/null)
      if [ "$st" = "MERGED" ] || [ "$st" = "CLOSED" ]; then
        main=$(git -C "$d" rev-parse --git-common-dir); main="${main%/.git}"
        git -C "$main" worktree remove --force "$d" && git -C "$main" branch -D "$br" >/dev/null 2>&1
        echo "Mac removed: $(basename "$d") (PR $(echo "$st" | tr A-Z a-z))"
      fi
    done ;;

  takeover)
    # Finish a Flex Rig task on the Mac: same branch, fresh Mac worktree, Mac's logins.
    # Brings over Flex Rig's commits AND uncommitted edits straight over SSH (works even if Flex Rig couldn't push).
    ID="${1:-}"; check_id "$ID"
    DEST="$MACWT/$ID"; [ -e "$DEST" ] && die "Already taken over: $DEST"
    R=$(remote bundle "$ID" | json_line)
    if [ -z "$R" ] || ! echo "$R" | jq -e .ok >/dev/null; then
      die "Couldn't get the work from Flex Rig ($( [ -n "$R" ] && echo "$R" | jq -r .error || echo "not reachable")). If it pushed its branch, use: git worktree add from origin/flexrig/$ID; otherwise start over on the Mac."
    fi
    REPO=$(echo "$R" | jq -r .repo); BRANCH=$(echo "$R" | jq -r .branch)
    MACREPO="$LOCAL_REPOS/$REPO"; [ -d "$MACREPO/.git" ] || die "No Mac checkout at $MACREPO"
    git -C "$MACREPO" rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null && die "Branch $BRANCH already exists on the Mac."
    mkdir -p "$MACWT"
    git -C "$MACREPO" fetch -q origin main || die "git fetch failed on the Mac."
    if [ "$(echo "$R" | jq -r .empty)" = "true" ]; then
      if git -C "$MACREPO" ls-remote --exit-code -q origin "refs/heads/$BRANCH" >/dev/null 2>&1; then
        git -C "$MACREPO" fetch -q origin "$BRANCH:refs/remotes/origin/$BRANCH"
        git -C "$MACREPO" worktree add -q -b "$BRANCH" "$DEST" "origin/$BRANCH"
      elif B=$(echo "$R" | jq -r '.base // empty') && [ -n "$B" ] && git -C "$MACREPO" fetch -q origin "+refs/heads/$B:refs/remotes/origin/$B" 2>/dev/null; then
        git -C "$MACREPO" worktree add -q -b "$BRANCH" "$DEST" "origin/$B"
      else
        git -C "$MACREPO" worktree add -q -b "$BRANCH" "$DEST" origin/main
      fi
      echo "Flex Rig had no work on this task yet. Mac worktree: $DEST (branch $BRANCH). Do the task there."
    else
      REF=$(echo "$R" | jq -r .ref); WIP=$(echo "$R" | jq -r .wip)
      mkdir -p "$HOME/.flexrig/bundles"; BUN="$HOME/.flexrig/bundles/$ID.bundle"
      scp -q -o ConnectTimeout=8 -o BatchMode=yes -o LogLevel=ERROR "$HOST:$(echo "$R" | jq -r .bundle)" "$BUN" || die "Couldn't copy the work from Flex Rig."
      git -C "$MACREPO" fetch -q "$BUN" "$REF:$REF" || die "Couldn't read the bundle."
      git -C "$MACREPO" worktree add -q -b "$BRANCH" "$DEST" "$REF" || die "git worktree add failed."
      [ "$WIP" = "true" ] && git -C "$DEST" reset -q HEAD~1
      git -C "$MACREPO" update-ref -d "$REF"; rm -f "$BUN"
      echo "Mac worktree: $DEST (branch $BRANCH) with Flex Rig's commits$( [ "$WIP" = "true" ] && echo " and its uncommitted edits (unstaged)"). Finish the task there with the Mac's logins, push, open/update the PR."
    fi ;;

  ask)
    RESUME=""; DIR="$DEFAULT_REPO"; AMODEL="default"; AEFFORT=""; AEFFORT_SET=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --model) AMODEL="$2"; check_model "$AMODEL"; shift 2 ;;
        --effort) AEFFORT="$2"; AEFFORT_SET=1; check_effort "$AEFFORT"; shift 2 ;;
        --resume) RESUME="$2"; shift 2 ;;
        --dir) DIR="$2"; shift 2 ;;
        --) shift; break ;;
        -*) die "Unknown option: $1" ;;
        *) break ;;
      esac
    done
    Q="${*:-}"; [ -n "$Q" ] || die "Give the question."
    [[ -z "$RESUME" || "$RESUME" =~ ^[0-9a-fA-F-]+$ ]] || die "Bad --resume id"
    [ -n "$DIR" ] || die "Name the folder with --dir NAME (or set FLEXRIG_DEFAULT_REPO in $CONFIG)."
    [[ "$DIR" =~ ^[A-Za-z0-9\ ._-]+$ ]] || die "Bad --dir"
    FLAGS="--allowedTools Read,Glob,Grep"; [ -n "$RESUME" ] && FLAGS="$FLAGS --resume $RESUME"
    [ $AEFFORT_SET = 1 ] || AEFFORT=$(chat_effort)
    [ "$AMODEL" = default ] || FLAGS="$FLAGS --model $AMODEL"
    [ -z "$AEFFORT" ] || [ "$AEFFORT" = default ] || FLAGS="$FLAGS --effort $AEFFORT"
    B=$(printf '%s' "$Q" | b64)
    REMOTE="\$ErrorActionPreference='Stop'; \$u=New-Object System.Text.UTF8Encoding \$false; \$OutputEncoding=\$u; [Console]::OutputEncoding=\$u; \
\$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$B')); \
Set-Location -LiteralPath '$REMOTE_REPOS\\$DIR'; \
\$p | claude -p --output-format json $FLAGS"
    J=$("${SSH[@]}" "$REMOTE" 2> >(quiet_err) | json_line)
    [ -n "$J" ] || die "Flex Rig not reachable or gave no answer."
    echo "$J" | jq -r '"Flex Rig session: \(.session_id)\n" + (if .is_error then "ERROR: " else "" end) + (.result // "")'
    ;;

  *)
    sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
