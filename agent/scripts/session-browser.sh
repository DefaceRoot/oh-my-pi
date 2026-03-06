#!/usr/bin/env bash
# OMP Session Browser — fzf + tmux session picker
# Add to ~/.tmux.conf: bind S display-popup -E -w '85%' -h '80%' "~/.omp/agent/scripts/session-browser.sh"
set -euo pipefail

for cmd in fzf tmux python3; do
	if ! command -v "$cmd" &>/dev/null; then
		echo "ERROR: $cmd is required."
		[[ "$cmd" == fzf ]] && echo "  Install: sudo dnf install fzf  OR  brew install fzf"
		exit 1
	fi
done

SESSION_DIR="$HOME/.omp/agent/sessions"
NOW_EPOCH=$(date +%s)

relative_time() {
	local epoch="$1"

	if [[ -z "$epoch" || "$epoch" -le 0 ]]; then
		echo "unknown"
		return
	fi

	local diff=$((NOW_EPOCH - epoch))
	(( diff < 0 )) && diff=0

	if (( diff < 60 )); then
		echo "${diff}s ago"
	elif (( diff < 3600 )); then
		echo "$((diff / 60))m ago"
	elif (( diff < 86400 )); then
		echo "$((diff / 3600))h ago"
	else
		echo "$((diff / 86400))d ago"
	fi
}

parse_session() {
	local file="$1"
	local first_line cwd timestamp parse_out
	local branch_line branch worktree_path
	local title_line session_title
	local session_type repo_root epoch reltime

	first_line=$(head -n 1 "$file" 2>/dev/null || true)
	[[ -z "$first_line" ]] && return 1

	if command -v jq >/dev/null 2>&1; then
		parse_out=$(printf '%s\n' "$first_line" | jq -r '[(.cwd // ""), (.timestamp // "")] | @tsv' 2>/dev/null || true)
	else
		parse_out=$(python3 - "$first_line" <<'PY' 2>/dev/null || true
import json
import sys

raw = sys.argv[1]
try:
    obj = json.loads(raw)
except Exception:
    print("\t")
    raise SystemExit(0)

cwd = obj.get("cwd")
timestamp = obj.get("timestamp")
print(f"{cwd if isinstance(cwd, str) else ''}\t{timestamp if isinstance(timestamp, str) else ''}")
PY
)
	fi

	cwd="${parse_out%%$'\t'*}"
	timestamp="${parse_out#*$'\t'}"
	[[ -z "$cwd" ]] && cwd="(unknown)"

	branch=""
	worktree_path=""
	branch_line=$(grep -F '"plan-worktree/state"' "$file" | tail -n 1 || true)
	if [[ -n "$branch_line" ]]; then
		if command -v jq >/dev/null 2>&1; then
			parse_out=$(printf '%s\n' "$branch_line" | jq -r '[(.data.branchName // ""), (.data.worktreePath // "")] | @tsv' 2>/dev/null || true)
		else
			parse_out=$(python3 - "$branch_line" <<'PY' 2>/dev/null || true
import json
import sys

raw = sys.argv[1]
try:
    obj = json.loads(raw)
except Exception:
    print("\t")
    raise SystemExit(0)

data = obj.get("data") if isinstance(obj, dict) else None
if not isinstance(data, dict):
    print("\t")
    raise SystemExit(0)

branch = data.get("branchName")
worktree = data.get("worktreePath")
print(f"{branch if isinstance(branch, str) else ''}\t{worktree if isinstance(worktree, str) else ''}")
PY
)
		fi
		branch="${parse_out%%$'\t'*}"
		worktree_path="${parse_out#*$'\t'}"
	fi

	session_title=""
	title_line=$(grep -m1 -F '"session-title"' "$file" 2>/dev/null || true)
	if [[ -n "$title_line" ]]; then
		if command -v jq >/dev/null 2>&1; then
			parse_out=$(printf '%s\n' "$title_line" | jq -r '.data.title // ""' 2>/dev/null || true)
		else
			parse_out=$(python3 - "$title_line" <<'PY' 2>/dev/null || true
import json
import sys

raw = sys.argv[1]
try:
    obj = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)

data = obj.get("data") if isinstance(obj, dict) else None
if not isinstance(data, dict):
    print("")
    raise SystemExit(0)

title = data.get("title")
print(title if isinstance(title, str) else "")
PY
)
		fi
		session_title="${parse_out//$'|'/ }"
	fi

	if [[ -n "$branch" ]]; then
		session_type="worktree"
	elif grep -qF '"plan-worktree/' "$file"; then
		session_type="planning"
	else
		session_type="general"
	fi

	repo_root="$cwd"
	if [[ "$repo_root" == *"/.worktrees/"* ]]; then
		repo_root="${repo_root%%/.worktrees/*}"
	elif [[ -n "$worktree_path" && "$worktree_path" == *"/.worktrees/"* ]]; then
		repo_root="${worktree_path%%/.worktrees/*}"
	fi

	epoch=$(python3 - "$timestamp" <<'PY' 2>/dev/null || true
from datetime import datetime, timezone
import sys

ts = sys.argv[1]
if not ts:
    print(0)
    raise SystemExit(0)
try:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
except Exception:
    print(0)
    raise SystemExit(0)
if dt.tzinfo is None:
    dt = dt.replace(tzinfo=timezone.utc)
print(int(dt.timestamp()))
PY
)
	[[ "$epoch" =~ ^[0-9]+$ ]] || epoch=0
	reltime=$(relative_time "$epoch")

	printf '%s|%s|%s|%s|%s|%s|%s\n' "$session_type" "$repo_root" "$branch" "$session_title" "$timestamp" "$reltime" "$file"
}

list_and_format() {
	local records=()
	local file record

	while IFS= read -r file; do
		record=$(parse_session "$file" || true)
		[[ -n "$record" ]] && records+=("$record")
	done < <(find "$SESSION_DIR" -name '*.jsonl' -type f 2>/dev/null)

	[[ ${#records[@]} -eq 0 ]] && return 1

	printf '%s\n' "${records[@]}" \
		| sort -t'|' -k5,5r \
		| while IFS='|' read -r session_type repo branch session_title _timestamp reltime filepath; do
			local display
			local repo_label="$repo"
			[[ -z "$repo_label" ]] && repo_label="(unknown)"

			if [[ "$repo_label" != "${last_repo:-}" ]]; then
				printf '# ──── %s ────\t\n' "$repo_label"
				last_repo="$repo_label"
			fi

			case "$session_type" in
				worktree)
					[[ -z "$branch" ]] && branch="worktree"
					if [[ -n "$session_title" ]]; then
						display=$(printf '\033[1;36m  [%s]\033[0m %s \033[2;37m(%s)\033[0m' "$branch" "$session_title" "$reltime")
					else
						display=$(printf '\033[1;36m  [%s]\033[0m \033[2;37m(%s)\033[0m' "$branch" "$reltime")
					fi
					;;
				planning)
					if [[ -n "$session_title" ]]; then
						display=$(printf '  %s \033[2;37m(%s)\033[0m' "$session_title" "$reltime")
					else
						display=$(printf '\033[0;34m  [planning]\033[0m \033[2;37m(%s)\033[0m' "$reltime")
					fi
					;;
				*)
					if [[ -n "$session_title" ]]; then
						display=$(printf '  %s \033[2;37m(%s)\033[0m' "$session_title" "$reltime")
					else
						display=$(printf '\033[2;37m  [session]\033[0m \033[2;37m(%s)\033[0m' "$reltime")
					fi
					;;
			esac

			printf '%s\t%s\n' "$display" "$filepath"
		done
}

if [[ ! -d "$SESSION_DIR" ]]; then
	echo "No OMP sessions found in $SESSION_DIR"
	exit 0
fi

if ! find "$SESSION_DIR" -name '*.jsonl' -type f -print -quit 2>/dev/null | grep -q .; then
	echo "No OMP sessions found in $SESSION_DIR"
	exit 0
fi

selected=$(list_and_format | fzf \
	--ansi \
	--no-sort \
	--delimiter=$'\t' \
	--with-nth=1 \
	--preview="$HOME/.omp/agent/scripts/session-preview.sh {2}" \
	--preview-window='right:42%:wrap' \
	--header=$'OMP Session Browser\n[Enter] resume  [Ctrl-C] cancel' \
	--prompt='  Search: ' \
	--bind='ctrl-c:abort' \
	--color='header:italic:dim' \
	--height=100% 2>/dev/null) || true

filepath=$(echo "$selected" | cut -d$'\t' -f2)
[[ -z "$filepath" || ! -f "$filepath" ]] && exit 0

tmux new-window "omp --session '$filepath'"
