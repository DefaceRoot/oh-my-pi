#!/usr/bin/env bash
# agents-view-manager.sh — Ensure Agents View window exists in tmux sessions.
#
# Usage:
#   agents-view-manager.sh ensure                  # ensure in current session
#   agents-view-manager.sh ensure-all              # ensure in ALL tmux sessions
#   agents-view-manager.sh respawn [session]       # kill + restart dashboard pane
#   agents-view-manager.sh watch-notify [session]  # monitor state changes + notify-send
#   agents-view-manager.sh watch-notify-all        # monitor all sessions in background
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_VIEW_PY="${SCRIPT_DIR}/agents-view.py"
WINDOW_NAME="Agents"
WINDOW_INDEX=1

ensure_session() {
  local session="$1"
  local window_exists=0
  local window_name_actual=""
  local session_path
  local idx wid wname

  # Check if window index 1 exists
  while IFS=$'\t' read -r idx wid wname; do
    if [[ "$idx" == "$WINDOW_INDEX" ]]; then
      window_exists=1
      window_name_actual="$wname"
    fi
  done < <(tmux list-windows -t "$session" -F '#{window_index}\t#{window_id}\t#{window_name}' 2>/dev/null || true)

  if ((window_exists)); then
    if [[ "$window_name_actual" == "$WINDOW_NAME" ]]; then
      # Check if agents-view.py is running in it
      local pane_command
      local running=0
      while IFS= read -r pane_command; do
        if [[ "$pane_command" == *"python3"* ]]; then
          running=1
        fi
      done < <(tmux list-panes -t "$session:$WINDOW_INDEX" -F '#{pane_current_command}' 2>/dev/null || true)

      if ((running)); then
        # Already running — keep existing pane and continue to sidebar ensure
        :
      else
        # Not running — respawn the dashboard in the existing window
        session_path="$(tmux display-message -p -t "$session" '#{session_path}' 2>/dev/null || echo '')"
        tmux respawn-pane -k -t "$session:${WINDOW_INDEX}.0" "python3 '$AGENTS_VIEW_PY' --scope-root '$session_path'" 2>/dev/null || true
      fi
    else
      # Window 1 exists but belongs to the user — move it, then create Agents at 1
      tmux move-window -s "$session:$WINDOW_INDEX" -t "$session:" 2>/dev/null || true
      session_path="$(tmux display-message -p -t "$session" '#{session_path}' 2>/dev/null || echo '')"
      tmux new-window -t "$session:$WINDOW_INDEX" -n "$WINDOW_NAME" -d \
        "python3 '$AGENTS_VIEW_PY' --scope-root '$session_path'" 2>/dev/null || \
        tmux new-window -a -t "$session:0" -n "$WINDOW_NAME" -d \
          "python3 '$AGENTS_VIEW_PY' --scope-root '$session_path'" 2>/dev/null || true
    fi
  else
    # Window 1 does not exist — create it
    session_path="$(tmux display-message -p -t "$session" '#{session_path}' 2>/dev/null || echo '')"
    tmux new-window -t "$session:$WINDOW_INDEX" -n "$WINDOW_NAME" -d \
      "python3 '$AGENTS_VIEW_PY' --scope-root '$session_path'" 2>/dev/null || \
      tmux new-window -a -t "$session:0" -n "$WINDOW_NAME" -d \
        "python3 '$AGENTS_VIEW_PY' --scope-root '$session_path'" 2>/dev/null || true
  fi

}

ensure_all() {
  local session
  while IFS= read -r session; do
    [[ -n "$session" ]] || continue
    ensure_session "$session" || true
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
}

respawn_session() {
  local session="$1"
  local session_path

  session_path="$(tmux display-message -p -t "$session" '#{session_path}' 2>/dev/null || echo '')"
  # Send quit to gracefully stop the dashboard
  tmux send-keys -t "$session:${WINDOW_INDEX}" 'q' '' 2>/dev/null || true
  sleep 0.5
  tmux respawn-pane -k -t "$session:${WINDOW_INDEX}.0" \
    "python3 '$AGENTS_VIEW_PY' --scope-root '$session_path'" 2>/dev/null || true
}

notify_desktop() {
  local title="$1"
  local body="$2"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "$title" "$body" >/dev/null 2>&1 || true
  fi
}

derive_dashboard_event() {
  local session="$1"
  local pane_text
  pane_text="$(tmux capture-pane -p -t "$session:${WINDOW_INDEX}.0" -S -120 2>/dev/null || true)"
  if [[ -z "$pane_text" ]]; then
    # Pane is blank: TUI is initializing or was just respawned — not a session end.
    echo ""
    return
  fi
  if [[ "$pane_text" == *"? STALL"* ]]; then
    echo "session_stalled"
    return
  fi
  if [[ "$pane_text" == *"! INPUT"* || "$pane_text" == *"● INPUT"* || "$pane_text" == *"INPUT "* ]]; then
    echo "session_asking"
    return
  fi
  if [[ "$pane_text" == *"WARNING:"* ]]; then
    echo "ctx_warn"
    return
  fi
  if [[ "$pane_text" == *"○ OFF "* ]]; then
    echo "session_done"
    return
  fi
  echo ""
}

watch_notify_session() {
  local session="$1"
  local prev_event=""
  local poll_seconds="${OMP_AGENTS_VIEW_NOTIFY_POLL_SECONDS:-2}"
  while tmux has-session -t "$session" 2>/dev/null; do
    local event
    event="$(derive_dashboard_event "$session")"
    if [[ -n "$event" && "$event" != "$prev_event" ]]; then
      case "$event" in
        session_done)
          notify_desktop "Agents View" "${session}: session done"
          ;;
        session_asking)
          notify_desktop "Agents View" "${session}: waiting for input"
          ;;
        session_stalled)
          notify_desktop "Agents View" "${session}: session stalled"
          ;;
        ctx_warn)
          notify_desktop "Agents View" "${session}: context warning"
          ;;
      esac
    fi
    prev_event="$event"
    sleep "$poll_seconds"
  done
}

watch_notify_all() {
  local session
  while IFS= read -r session; do
    [[ -n "$session" ]] || continue
    watch_notify_session "$session" &
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
  wait
}

case "${1:-ensure}" in
  ensure)
    SESSION="${2:-$(tmux display-message -p '#{client_session}' 2>/dev/null || echo '')}"
    [[ -n "$SESSION" ]] || { echo "Not in a tmux session" >&2; exit 1; }
    ensure_session "$SESSION"
    ;;
  ensure-all)
    while IFS= read -r session; do
      [[ -n "$session" ]] || continue
      ensure_session "$session" || true
    done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
    ;;
  respawn)
    SESSION="${2:-$(tmux display-message -p '#{client_session}' 2>/dev/null || echo '')}"
    [[ -n "$SESSION" ]] || { echo "Not in a tmux session" >&2; exit 1; }
    respawn_session "$SESSION"
    ;;
  watch-notify)
    SESSION="${2:-$(tmux display-message -p '#{client_session}' 2>/dev/null || echo '')}"
    [[ -n "$SESSION" ]] || { echo "Not in a tmux session" >&2; exit 1; }
    watch_notify_session "$SESSION"
    ;;
  watch-notify-all)
    watch_notify_all
    ;;
  *)
    echo "Usage: $0 {ensure|ensure-all|respawn|watch-notify|watch-notify-all} [session]" >&2
    exit 1
    ;;
esac
