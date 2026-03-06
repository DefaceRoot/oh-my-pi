#!/usr/bin/env bash
set -euo pipefail

action="${1:-format}"
target_id="${2:-}"

read_cmdline() {
  local pid="$1"
  local cmdline_path="/proc/$pid/cmdline"
  if [[ -r "$cmdline_path" ]]; then
    tr '\0' ' ' < "$cmdline_path"
  fi
}

is_omp_process() {
  local pid="$1"
  local cmdline

  cmdline="$(read_cmdline "$pid")"
  if [[ "$cmdline" == *"/.bun/bin/omp"* ]] || [[ "$cmdline" == *"/bin/omp"* ]] || [[ "$cmdline" == *" oh-my-pi "* ]] || [[ "$cmdline" == *" pi-coding-agent "* ]] ||
    ([[ "$cmdline" == *"packages/coding-agent"* ]] && [[ "$cmdline" == *"src/cli.ts"* ]]) ||
    ([[ "$cmdline" == *"/oh-my-pi"* ]] && [[ "$cmdline" == *" run dev"* ]]); then
    return 0
  fi

  return 1
}

is_claude_process() {
  local pid="$1"
  local cmdline

  cmdline="$(read_cmdline "$pid")"
  if [[ "$cmdline" == *"@anthropic-ai/claude-code"* ]] || [[ "$cmdline" == *"/claude-code"* ]] || [[ "$cmdline" =~ (^|[[:space:]/])claude([[:space:]]|$) ]]; then
    return 0
  fi

  return 1
}

is_codex_process() {
  local pid="$1"
  local cmdline

  cmdline="$(read_cmdline "$pid")"
  if [[ "$cmdline" == *"openai/codex"* ]] || [[ "$cmdline" == *"codex-cli"* ]] || [[ "$cmdline" =~ (^|[[:space:]/])codex([[:space:]]|$) ]]; then
    return 0
  fi

  return 1
}

is_opencode_process() {
  local pid="$1"
  local cmdline

  cmdline="$(read_cmdline "$pid")"
  if [[ "$cmdline" == *"opencode"* ]]; then
    return 0
  fi

  return 1
}

find_matching_pid() {
  local root_pid="$1"
  local matcher="$2"
  local queue=()
  local current
  local depth=0
  local next_level=()
  local children

  queue=("$root_pid")

  while ((${#queue[@]} > 0)) && ((depth < 5)); do
    next_level=()
    for current in "${queue[@]}"; do
      [[ -z "$current" ]] && continue
      if "$matcher" "$current"; then
        printf '%s' "$current"
        return 0
      fi

      if [[ -r "/proc/$current/task/$current/children" ]]; then
        children="$(<"/proc/$current/task/$current/children")"
        if [[ -n "$children" ]]; then
          for child in $children; do
            next_level+=("$child")
          done
        fi
      fi
    done

    queue=("${next_level[@]}")
    depth=$((depth + 1))
  done

  return 1
}

detect_omp_session_file() {
  local omp_pid="$1"
  local fd_path
  local target
  local newest_epoch=-1
  local newest_file=""
  local mtime

  for fd_path in /proc/"$omp_pid"/fd/*; do
    [[ -e "$fd_path" ]] || continue
    target="$(readlink "$fd_path" 2>/dev/null || true)"
    [[ -z "$target" ]] && continue

    if [[ "$target" =~ /agent/sessions/[^/]+/[0-9]{4}-[0-9]{2}-[0-9]{2}T[^/]*_[0-9a-f]+\.jsonl$ ]]; then
      mtime="$(stat -c %Y "$target" 2>/dev/null || printf '0')"
      if [[ "$mtime" =~ ^[0-9]+$ ]] && ((mtime > newest_epoch)); then
        newest_epoch="$mtime"
        newest_file="$target"
      fi
    fi
  done

  if [[ -n "$newest_file" ]]; then
    printf '%s' "$newest_file"
    return 0
  fi

  return 1
}

session_id_from_file() {
  local session_file="$1"
  if [[ "$session_file" =~ _([0-9a-f]+)\.jsonl$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

trim_text() {
  local value="$1"
  value="${value//$'\n'/ }"
  value="${value//$'\r'/ }"
  value="${value//$'\t'/ }"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

session_title_from_file() {
  local session_file="$1"
  local first_line=""
  local title_line=""
  local parsed=""

  [[ -r "$session_file" ]] || return 1

  first_line="$(head -n 1 "$session_file" 2>/dev/null || true)"
  if [[ -n "$first_line" ]]; then
    if command -v jq >/dev/null 2>&1; then
      parsed="$(printf '%s\n' "$first_line" | jq -r '.title // ""' 2>/dev/null || true)"
    elif command -v python3 >/dev/null 2>&1; then
      parsed="$(python3 - "$first_line" <<'PY' 2>/dev/null || true
import json
import sys

raw = sys.argv[1]
try:
    obj = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)

title = obj.get("title") if isinstance(obj, dict) else ""
print(title if isinstance(title, str) else "")
PY
)"
    fi
  fi

  if [[ -z "$parsed" ]]; then
    title_line="$(grep -m1 -F '"session-title"' "$session_file" 2>/dev/null || true)"
    if [[ -n "$title_line" ]]; then
      if command -v jq >/dev/null 2>&1; then
        parsed="$(printf '%s\n' "$title_line" | jq -r '.data.title // ""' 2>/dev/null || true)"
      elif command -v python3 >/dev/null 2>&1; then
        parsed="$(python3 - "$title_line" <<'PY' 2>/dev/null || true
import json
import sys

raw = sys.argv[1]
try:
    obj = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)

data = obj.get("data") if isinstance(obj, dict) else None
title = data.get("title") if isinstance(data, dict) else ""
print(title if isinstance(title, str) else "")
PY
)"
      fi
    fi
  fi

  parsed="$(trim_text "$parsed")"
  [[ -n "$parsed" ]] || return 1
  printf '%s' "$parsed"
}

truncate_text() {
  local text="$1"
  local max_len="$2"

  if ! [[ "$max_len" =~ ^[0-9]+$ ]] || ((max_len <= 0)); then
    return 0
  fi

  if ((${#text} > max_len)); then
    printf '%s' "${text:0:max_len}"
  else
    printf '%s' "$text"
  fi
}

compose_centered_title() {
  local width="$1"
  local left_text="$2"
  local center_text="$3"
  local left_trunc
  local center_trunc
  local center_len
  local center_styled
  local start
  local canvas
  local prefix
  local suffix_start
  local suffix=""

  if ! [[ "$width" =~ ^[0-9]+$ ]] || ((width <= 0)); then
    printf '%s' "$left_text"
    return 0
  fi

  left_trunc="$(truncate_text "$left_text" "$width")"
  center_trunc="$(truncate_text "$center_text" "$width")"
  center_len="${#center_trunc}"
  center_styled="#[bold]${center_trunc}#[nobold]"

  printf -v canvas '%*s' "$width" ''
  canvas="${left_trunc}${canvas:${#left_trunc}}"

  if ((center_len == 0)); then
    printf '%s' "$canvas"
    return 0
  fi

  start=$(((width - center_len) / 2))
  ((start < 0)) && start=0
  suffix_start=$((start + center_len))

  prefix="${canvas:0:start}"
  if ((suffix_start < width)); then
    suffix="${canvas:suffix_start}"
  fi

  printf '%s%s%s' "$prefix" "$center_styled" "$suffix"
}

array_contains() {
  local needle="$1"
  shift
  local value
  for value in "$@"; do
    [[ "$value" == "$needle" ]] && return 0
  done
  return 1
}

shorten_session_segment() {
  local segment="$1"
  local cleaned
  local token
  local lower
  local canonical
  local -a tokens=()
  local -a kept=()
  local output=""
  local i

  cleaned="$(trim_text "$segment")"
  [[ -n "$cleaned" ]] || return 1

  read -r -a tokens <<<"$cleaned"
  for token in "${tokens[@]}"; do
    canonical="${token//[^[:alnum:]+#-]/}"
    [[ -n "$canonical" ]] || continue

    lower="$(printf '%s' "$canonical" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      a|an|the|to|for|of|in|on|with|without|and|or|my|custom|session|window|title|oh|pi|omp)
        continue
        ;;
    esac
    kept+=("$canonical")
  done

  if ((${#kept[@]} == 0)); then
    for token in "${tokens[@]}"; do
      canonical="${token//[^[:alnum:]+#-]/}"
      [[ -n "$canonical" ]] || continue
      kept+=("$canonical")
      if ((${#kept[@]} >= 3)); then
        break
      fi
    done
  fi

  [[ ${#kept[@]} -gt 0 ]] || return 1

  output="${kept[0]}"
  for ((i = 1; i < ${#kept[@]} && i < 3; i++)); do
    output+=" ${kept[i]}"
  done

  output="$(truncate_text "$output" 28)"
  printf '%s' "$output"
}

emit_shortened_title_segments() {
  local raw_title="$1"
  local normalized
  local part
  local shortened
  local -a parts=()

  normalized="$(trim_text "$raw_title")"
  [[ -n "$normalized" ]] || return 0

  IFS='|' read -r -a parts <<<"$normalized"
  if ((${#parts[@]} == 0)); then
    parts=("$normalized")
  fi

  for part in "${parts[@]}"; do
    shortened="$(shorten_session_segment "$part" || true)"
    [[ -n "$shortened" ]] || continue
    printf '%s\n' "$shortened"
  done
}

derive_labels_for_pid() {
  local pane_pid="$1"
  local pane_command="$2"
  local program_label="$pane_command"
  local window_label="$pane_command"
  local omp_pid=""
  local claude_pid=""
  local omp_session_id=""
  local omp_session_file=""
  local omp_session_title=""

  omp_pid="$(find_matching_pid "$pane_pid" is_omp_process || true)"
  if [[ -n "$omp_pid" ]]; then
    omp_session_file="$(detect_omp_session_file "$omp_pid" || true)"
    if [[ -n "$omp_session_file" ]]; then
      omp_session_id="$(session_id_from_file "$omp_session_file" || true)"
      omp_session_title="$(session_title_from_file "$omp_session_file" || true)"
    fi

    if [[ -n "$omp_session_id" ]]; then
      program_label="OMP / $omp_session_id"
    else
      program_label="Oh My Pi"
    fi
    window_label="OMP"
  else
    claude_pid="$(find_matching_pid "$pane_pid" is_claude_process || true)"
    if [[ -n "$claude_pid" ]]; then
      program_label="Claude Code"
      window_label="Claude"
    else
      local codex_pid=""
      local opencode_pid=""
      codex_pid="$(find_matching_pid "$pane_pid" is_codex_process || true)"
      if [[ -n "$codex_pid" ]]; then
        program_label="Codex"
        window_label="Codex"
      else
        opencode_pid="$(find_matching_pid "$pane_pid" is_opencode_process || true)"
        if [[ -n "$opencode_pid" ]]; then
          program_label="OpenCode"
          window_label="OpenCode"
        fi
      fi
    fi
  fi

  if [[ -z "$program_label" ]]; then
    program_label="shell"
  fi

  if [[ -z "$window_label" ]]; then
    window_label="$program_label"
  fi

  printf '%s\t%s\t%s\t%s' "$program_label" "$window_label" "$omp_session_title" "$omp_session_id"
}

build_pane_titles() {
  local pane_id="$1"
  local pane_index
  local pane_pid
  local pane_width
  local pane_command
  local labels
  local program_label
  local window_label
  local omp_session_title
  local omp_session_id
  local title_left
  local title
  local copy_title

  pane_index="$(tmux display-message -p -t "$pane_id" '#{pane_index}')"
  pane_pid="$(tmux display-message -p -t "$pane_id" '#{pane_pid}')"
  pane_width="$(tmux display-message -p -t "$pane_id" '#{pane_width}')"
  pane_command="$(tmux display-message -p -t "$pane_id" '#{pane_current_command}')"

  labels="$(derive_labels_for_pid "$pane_pid" "$pane_command")"
  IFS=$'\t' read -r program_label window_label omp_session_title omp_session_id <<<"$labels"

  title_left="${pane_index} | ${program_label} | ${pane_id} | ${pane_pid}"
  title="$title_left"
  copy_title="$title_left"

  if [[ -n "$omp_session_title" ]]; then
    title="$(compose_centered_title "$pane_width" "$title_left" "$omp_session_title")"
    copy_title="${title_left} | ${omp_session_title}"
  fi

  printf '%s\t%s\t%s' "$title" "$copy_title" "$window_label"
}

build_window_label() {
  local window_id="$1"
  local pane_line
  local pane_id=""
  local pane_pid=""
  local pane_command=""
  local pane_active=""
  local sidebar_role=""
  local labels
  local pane_window_label
  local pane_session_title
  local fallback_command="shell"
  local label=""
  local joined=""
  local segment
  local has_omp=0
  local has_claude=0
  local has_codex=0
  local has_opencode=0
  local session_count=0
  local -a omp_segments=()

  while IFS='|' read -r pane_id pane_pid pane_command pane_active sidebar_role; do
    [[ -z "$pane_id" ]] && continue
    [[ "$sidebar_role" == "1" ]] && continue

    if [[ "$pane_active" == "1" ]] && [[ -n "$pane_command" ]]; then
      fallback_command="$pane_command"
    fi

    labels="$(derive_labels_for_pid "$pane_pid" "$pane_command")"
    IFS=$'\t' read -r _ pane_window_label pane_session_title _ <<<"$labels"

    if [[ "$pane_window_label" == "OMP" ]]; then
      has_omp=1
      while IFS= read -r segment; do
        [[ -n "$segment" ]] || continue
        if ! array_contains "$segment" "${omp_segments[@]}"; then
          omp_segments+=("$segment")
        fi
      done < <(emit_shortened_title_segments "$pane_session_title")
    elif [[ "$pane_window_label" == "Claude" ]]; then
      has_claude=1
    elif [[ "$pane_window_label" == "Codex" ]]; then
      has_codex=1
    elif [[ "$pane_window_label" == "OpenCode" ]]; then
      has_opencode=1
    fi
  done < <(tmux list-panes -t "$window_id" -F '#{pane_id}|#{pane_pid}|#{pane_current_command}|#{?pane_active,1,0}|#{@sidebar_role}')

  if ((has_omp)); then
    if ((${#omp_segments[@]} > 0)); then
      for segment in "${omp_segments[@]}"; do
        joined+="${joined:+ | }${segment}"
        session_count=$((session_count + 1))
        if ((session_count >= 3)); then
          break
        fi
      done
      label="OMP - ${joined}"
    else
      label="OMP"
    fi
  elif ((has_claude)); then
    label="Claude"
  elif ((has_codex)); then
    label="Codex"
  elif ((has_opencode)); then
    label="OpenCode"
  else
    label="$fallback_command"
  fi

  [[ -n "$label" ]] || label="shell"
  label="$(truncate_text "$label" 72)"
  printf '%s' "$label"
}

copy_to_clipboard() {
  local value="$1"
  if command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$value" | wl-copy
  elif command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$value" | pbcopy
  elif command -v xclip >/dev/null 2>&1; then
    printf '%s' "$value" | xclip -selection clipboard
  elif command -v xsel >/dev/null 2>&1; then
    printf '%s' "$value" | xsel -ib
  else
    return 1
  fi
}

case "$action" in
  format)
    pane_id="${target_id:-$(tmux display-message -p '#{pane_id}')}"
    pane_payload="$(build_pane_titles "$pane_id")"
    IFS=$'\t' read -r title _ _ <<<"$pane_payload"
    printf '%s' "$title"
    ;;
  window)
    if [[ -n "$target_id" ]] && [[ "$target_id" == %* ]]; then
      pane_payload="$(build_pane_titles "$target_id")"
      IFS=$'\t' read -r _ _ pane_window_label <<<"$pane_payload"
      printf '%s' "$pane_window_label"
    else
      window_id="${target_id:-$(tmux display-message -p '#{window_id}')}"
      build_window_label "$window_id"
    fi
    ;;
  copy)
    pane_id="${target_id:-$(tmux display-message -p '#{pane_id}')}"
    pane_payload="$(build_pane_titles "$pane_id")"
    IFS=$'\t' read -r _ copy_title _ <<<"$pane_payload"
    if copy_to_clipboard "$copy_title"; then
      tmux display-message "Copied pane title: $copy_title"
    else
      tmux display-message "No clipboard tool found (wl-copy/pbcopy/xclip/xsel)"
      exit 1
    fi
    ;;
  *)
    printf 'Unknown action: %s\n' "$action" >&2
    exit 2
    ;;
esac