#!/usr/bin/env bash
set -euo pipefail

cwd="$(pwd -P)"
root_path="$cwd"
repo_name="$(basename "$cwd")"
branch="-"
worktree_label="n/a"

if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  root_path="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$cwd")"
  branch="$(git -C "$cwd" symbolic-ref --short -q HEAD 2>/dev/null || git -C "$cwd" rev-parse --short HEAD 2>/dev/null || printf '-')"

  common_dir="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git -C "$cwd" rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$common_dir" ] && [ -d "$common_dir" ]; then
    repo_name="$(basename "$(cd "$common_dir/.." && pwd -P)")"
  else
    repo_name="$(basename "$root_path")"
  fi

  if [[ "$root_path" == *"/.worktrees/"* ]]; then
    worktree_label="$(basename "$root_path")"
  else
    worktree_label="main"
  fi
fi

pane_width="$(tput cols 2>/dev/null || printf '80')"
if ! [[ "$pane_width" =~ ^[0-9]+$ ]]; then
  pane_width=80
fi
if [ "$pane_width" -lt 32 ]; then
  pane_width=32
fi

line() {
  local char="$1"
  printf '%*s\n' "$pane_width" '' | tr ' ' "$char"
}

c_title='\033[1;38;5;45m'
c_meta='\033[38;5;250m'
c_path='\033[38;5;111m'
c_reset='\033[0m'

line '='
printf "${c_title}  EXPLORER | %s${c_reset}\n" "$repo_name"
line '-'
printf "${c_meta}  branch:${c_reset} %s\n" "$branch"
printf "${c_meta}  worktree:${c_reset} %s\n" "$worktree_label"
printf "${c_meta}  root:${c_reset} ${c_path}%s${c_reset}\n" "$root_path"
line '-'

if command -v tree >/dev/null 2>&1; then
  tree -a -C --dirsfirst -I '.git' "$root_path"
else
  printf "${c_meta}[tree not installed; showing 2-level fallback]\n${c_reset}"
  find "$root_path" -mindepth 1 -maxdepth 2 -print | sed "s#^$root_path#.#"
fi
