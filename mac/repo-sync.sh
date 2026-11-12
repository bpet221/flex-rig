#!/bin/bash
# Keeps the Mac's repo folders (FLEXRIG_LOCAL_REPOS in ~/.flexrig/config, default ~/Code) up to date with GitHub. Fast-forward only.
#
#   repo-sync.sh             every repo directly under that folder (LaunchAgent com.flexrig.repo-sync, every 10 min);
#                            a repo that can't update gets ONE Mac notification per problem
#   repo-sync.sh NAME|PATH   just that repo, prints one plain line (flexrig.sh runs this after a merge)
#
# Only updates main (the repo's default branch) while it's checked out and holds no commits that
# aren't on GitHub. Never stashes, resets, commits, switches branches or deletes anything.
# Local edits are fine as long as GitHub didn't change the same files (git itself refuses
# anything that would overwrite one). When GitHub did change a file the user has edited, it only
# moves on when nothing can be lost:
#   - their copy is already identical to GitHub's (it gets staged, so git can move on), or
#   - their copy is exactly what flexrig.sh pushed for them (~/.flexrig/pushed.log) and that push is
#     now merged into main: their version is saved in git history, so the file takes GitHub's version.
# Anything else is left alone and reported.
set -uo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never LC_ALL=C
FR="${FLEXRIG_HOME:-$HOME/.flexrig}"
[ -f "$FR/config" ] && . "$FR/config"
ROOT="${REPO_SYNC_ROOT:-${FLEXRIG_LOCAL_REPOS:-$HOME/Code}}"
STATE="$FR/repo-sync"
PUSHED="$FR/pushed.log"     # "<repo path><TAB><commit>" written by flexrig.sh start
LOG="${REPO_SYNC_LOG:-$HOME/Library/Logs/flexrig-repo-sync.log}"
mkdir -p "$STATE" "$(dirname "$LOG")"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/repo-sync.XXXXXX"); trap 'rm -rf "$TMP"' EXIT
G=(git -c core.quotePath=false -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30)

ONE=""; [ $# -gt 0 ] && ONE="$1"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
say() { log "$*"; [ -n "$ONE" ] && echo "$*"; return 0; }
slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

# A problem is notified once; the same problem again stays quiet until it's fixed.
problem() { # repo-name key message
  local f="$STATE/$(slug "$1").problem"
  say "$3"
  [ -n "$ONE" ] && return 0
  if [ "$(cat "$f" 2>/dev/null)" != "$2" ]; then
    printf '%s' "$2" > "$f"
    local msg=${3//\\/\\\\}; msg=${msg//\"/\\\"}
    [ -z "${REPO_SYNC_QUIET:-}" ] && osascript -e "display notification \"$msg\" with title \"Repo sync\" subtitle \"$1 can't update\" sound name \"Funk\"" >/dev/null 2>&1 || true
    log "notified: $3"
  fi
}
fixed() { rm -f "$STATE/$(slug "$1").problem"; }

blob_of() { git -C "$1" rev-parse -q --verify "$2:$3" 2>/dev/null; }   # dir commit path

sync_one() {
  local dir="$1" name; name=$(basename "$dir")
  [ -d "$dir/.git" ] || [ -f "$dir/.git" ] || { [ -n "$ONE" ] && say "$name: not a git repo"; return 0; }
  local gd; gd=$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null) || return 0
  if [ -e "$gd/MERGE_HEAD" ] || [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ] || [ -e "$gd/CHERRY_PICK_HEAD" ]; then
    say "$name: in the middle of a merge or rebase, left alone"; return 0
  fi
  local out
  if ! out=$("${G[@]}" -C "$dir" fetch -q origin 2>&1); then
    if echo "$out" | grep -qiE 'authentication|could not read username|permission denied|403|404'; then
      problem "$name" "fetch-login" "$name: can't read GitHub (login problem), so it can't update."
    else
      say "$name: couldn't reach GitHub (offline?), will try again"
    fi
    return 0
  fi
  local def; def=$(git -C "$dir" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); def=${def#origin/}; def=${def:-main}
  local up="origin/$def" cur; cur=$(git -C "$dir" branch --show-current)
  git -C "$dir" rev-parse -q --verify "$up" >/dev/null || { say "$name: no $up on GitHub, left alone"; return 0; }
  if [ "$cur" != "$def" ]; then say "$name: on branch ${cur:-(detached)}, not $def, left alone"; fixed "$name"; return 0; fi
  local counts ahead behind
  counts=$(git -C "$dir" rev-list --left-right --count "HEAD...$up") || return 0
  ahead=${counts%%[[:space:]]*}; behind=${counts##*[[:space:]]}
  if [ "$behind" = 0 ]; then say "$name: up to date"; fixed "$name"; return 0; fi
  if [ "$ahead" != 0 ]; then
    problem "$name" "diverged:$(git -C "$dir" rev-parse HEAD)" "$name: your Mac's $def has $ahead commit(s) that aren't on GitHub, and GitHub has $behind new one(s). It can't update on its own."
    return 0
  fi
  if git -C "$dir" merge --ff-only -q "$up" >/dev/null 2>&1; then
    say "$name: updated ($behind new commit(s) from GitHub)"; fixed "$name"; return 0
  fi

  # Blocked: find local edits to files GitHub also changed.
  git -C "$dir" diff --no-renames --name-only -z HEAD | tr '\0' '\n' > "$TMP/d1"
  git -C "$dir" ls-files -z --others --exclude-standard | tr '\0' '\n' >> "$TMP/d1"
  git -C "$dir" diff --no-renames --name-only -z HEAD "$up" | tr '\0' '\n' | sort -u > "$TMP/changed"
  sort -u "$TMP/d1" > "$TMP/dirty"
  comm -12 "$TMP/dirty" "$TMP/changed" > "$TMP/overlap"
  # Commits flexrig.sh pushed from this folder that are now merged into main.
  : > "$TMP/merged"
  if [ -f "$PUSHED" ]; then
    awk -F'\t' -v d="$dir" '$1==d {print $2}' "$PUSHED" | while read -r c; do
      git -C "$dir" merge-base --is-ancestor "$c" "$up" 2>/dev/null && echo "$c"
    done > "$TMP/merged"
  fi
  : > "$TMP/stage"; : > "$TMP/take"; : > "$TMP/block"
  local f wt upb idx headb ok c
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    wt=""; [ -e "$dir/$f" ] && wt=$(git -C "$dir" hash-object -- "$f")
    upb=$(blob_of "$dir" "$up" "$f"); headb=$(blob_of "$dir" HEAD "$f")
    idx=$(git -C "$dir" ls-files -s -- "$f" | awk '{print $2; exit}')
    # A half-staged file (index matches neither HEAD nor GitHub) is never touched.
    if [ -n "$idx" ] && [ "$idx" != "$headb" ] && [ "$idx" != "$upb" ] && [ "$idx" != "$wt" ]; then echo "$f" >> "$TMP/block"; continue; fi
    if [ "$wt" = "$upb" ]; then echo "$f" >> "$TMP/stage"; continue; fi
    ok=""
    if [ -n "$wt" ] && [ -n "$upb" ]; then
      while read -r c; do [ -n "$c" ] && [ "$(blob_of "$dir" "$c" "$f")" = "$wt" ] && { ok=1; break; }; done < "$TMP/merged"
    fi
    if [ -n "$ok" ]; then echo "$f" >> "$TMP/take"; else echo "$f" >> "$TMP/block"; fi
  done < "$TMP/overlap"

  if [ -s "$TMP/block" ] || { [ ! -s "$TMP/stage" ] && [ ! -s "$TMP/take" ]; }; then
    local n list
    n=$(wc -l < "$TMP/block" | tr -d ' ')
    list=$(head -3 "$TMP/block" | sed 's#.*/##' | paste -sd, - | sed 's/,/, /g')
    if [ "$n" = 0 ]; then
      problem "$name" "blocked:other:$(git -C "$dir" rev-parse "$up")" "$name: git couldn't update it ($(git -C "$dir" merge --ff-only "$up" 2>&1 | head -1))."
    else
      problem "$name" "blocked:$(sort "$TMP/block" | shasum | cut -c1-12)" "$name: $n file(s) you changed on the Mac were also changed on GitHub ($list$( [ "$n" -gt 3 ] && echo ', ...')). It won't update until you save or undo those edits."
    fi
    return 0
  fi
  # Safe: staged files already match GitHub; "take" files are the user's pushed+merged version.
  [ -s "$TMP/stage" ] && tr '\n' '\0' < "$TMP/stage" | git -C "$dir" add -A --pathspec-from-file=- --pathspec-file-nul
  [ -s "$TMP/take" ] && tr '\n' '\0' < "$TMP/take" | git -C "$dir" checkout -q "$up" --pathspec-from-file=- --pathspec-file-nul
  if out=$(git -C "$dir" merge --ff-only -q "$up" 2>&1); then
    local k=$(( $(wc -l < "$TMP/stage") + $(wc -l < "$TMP/take") ))
    say "$name: updated ($behind new commit(s) from GitHub; $k of your local edits were already in them)"; fixed "$name"
  else
    problem "$name" "blocked:after:$(git -C "$dir" rev-parse "$up")" "$name: git couldn't update it ($(echo "$out" | head -1))."
  fi
}

if [ -n "$ONE" ]; then
  case "$ONE" in /*) d="$ONE" ;; *) d="$ROOT/$ONE" ;; esac
  [ -d "$d" ] || { echo "No folder $d"; exit 1; }
  sync_one "$(cd "$d" && pwd)"
else
  for d in "$ROOT"/*/; do
    d="${d%/}"
    case "$(basename "$d")" in _scratch) continue ;; esac
    [ -e "$d/.git" ] || continue
    sync_one "$d"
  done
  # Keep the log small.
  [ "$(wc -l < "$LOG")" -gt 5000 ] && tail -2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  # The Code work bar's model menu (local files only, instant), and about once a day Flex Rig's Claude Code
  # (skipped while a task runs there, or when Flex Rig isn't reachable).
  FX="$(cd "$(dirname "$0")" && pwd)/flexrig.sh"
  if [ -x "$FX" ]; then
    "$FX" models >/dev/null 2>&1 || log "models list: couldn't refresh"
    U=$("$FX" update-flexrig --if-stale 2>&1) && [ -n "$U" ] && log "$U"
  fi
fi
exit 0
