#!/usr/bin/env bash
# OMP Menu Popup — Centered within the ACTIVE TMUX PANE, not the full window
#
# Usage: menu-popup.sh [--multi] "Menu Title" "Option 1" "Option 2" ...
# Output: prints selected option(s) to stdout, empty if cancelled
# Exit: 0 on selection, 1 on cancel/abort

set -euo pipefail

MULTI_MODE=0
if [ "${1:-}" = "--multi" ]; then
  MULTI_MODE=1
  shift
fi

TITLE="${1:-Menu}"
shift

if [ $# -eq 0 ]; then
  exit 1
fi

# Build newline-separated options
OPTIONS=""
for opt in "$@"; do
  OPTIONS="${OPTIONS}${OPTIONS:+$'\n'}${opt}"
done

# Target popup size (columns × rows) — will be clamped to pane size
OPTION_COUNT=$#
POPUP_W=58
POPUP_H=$(( OPTION_COUNT + 9 ))   # options + border + header + footer + padding
[ "$POPUP_H" -lt 13 ] && POPUP_H=13
[ "$POPUP_H" -gt 30 ] && POPUP_H=30

# Temp files
TMP_IN="$(mktemp /tmp/omp-menu-in.XXXXXX)"
TMP_OUT="$(mktemp /tmp/omp-menu-out.XXXXXX)"
trap 'rm -f "$TMP_IN" "$TMP_OUT"' EXIT

printf '%s' "$OPTIONS" > "$TMP_IN"

# fzf color scheme: GitHub Dark — high contrast, white border, no terminal bleed
FZF_COLORS="bg:#0d1117,bg+:#1c2128,fg:#cdd9e5,fg+:#ffffff"
FZF_COLORS="${FZF_COLORS},hl:#539bf5,hl+:#6bc7f6"
FZF_COLORS="${FZF_COLORS},header:#6e7681,border:#e6edf3,label:#539bf5"
FZF_COLORS="${FZF_COLORS},prompt:#57ab5a,pointer:#e5534b,info:#6e7681"
FZF_COLORS="${FZF_COLORS},separator:#21262d,scrollbar:#e6edf3"

FZF_CMD="fzf"
FZF_CMD="${FZF_CMD} --border=rounded"
FZF_CMD="${FZF_CMD} --border-label=' ${TITLE} '"
FZF_CMD="${FZF_CMD} --border-label-pos=0"
FZF_CMD="${FZF_CMD} --padding=1,3"
FZF_CMD="${FZF_CMD} --prompt='  ❯  '"
FZF_CMD="${FZF_CMD} --pointer='▶'"
if [ "$MULTI_MODE" -eq 1 ]; then
  FZF_CMD="${FZF_CMD} --multi"
fi
FZF_CMD="${FZF_CMD} --marker=' '"
FZF_CMD="${FZF_CMD} --color='${FZF_COLORS}'"
FZF_CMD="${FZF_CMD} --bind='esc:abort,ctrl-c:abort,ctrl-q:abort'"
FZF_CMD="${FZF_CMD} --no-sort --no-info"
FZF_CMD="${FZF_CMD} --preview='printf \"\\033[2m  ↑↓ navigate   Enter select   Esc cancel\\033[0m\"'"
FZF_CMD="${FZF_CMD} --preview-window='bottom:1:noborder'"
FZF_CMD="${FZF_CMD} < '${TMP_IN}' > '${TMP_OUT}' 2>/dev/null"

if [ -n "${TMUX:-}" ]; then
  # ── Get current pane geometry (position in window + size) ──────────────────
  # pane_left/top = absolute column/row of pane's top-left corner in the window
  # pane_width/height = dimensions in columns/rows
  _PANE_GEOM="$(tmux display-message -p '#{pane_left} #{pane_top} #{pane_width} #{pane_height}')"
  PANE_LEFT="${_PANE_GEOM%% *}"; _PANE_GEOM="${_PANE_GEOM#* }"
  PANE_TOP="${_PANE_GEOM%% *}";  _PANE_GEOM="${_PANE_GEOM#* }"
  PANE_W="${_PANE_GEOM%% *}"
  PANE_H="${_PANE_GEOM##* }"

  # Clamp popup to fit within pane (2-col/2-row margin on each side)
  MAX_W=$(( PANE_W - 4 ))
  MAX_H=$(( PANE_H - 4 ))
  [ "$MAX_W" -lt 20 ] && MAX_W=20
  [ "$MAX_H" -lt 8  ] && MAX_H=8
  [ "$POPUP_W" -gt "$MAX_W" ] && POPUP_W=$MAX_W
  [ "$POPUP_H" -gt "$MAX_H" ] && POPUP_H=$MAX_H

  # Center popup within pane using absolute window coordinates
  POPUP_X=$(( PANE_LEFT + (PANE_W - POPUP_W) / 2 ))
  POPUP_Y=$(( PANE_TOP  + (PANE_H - POPUP_H) / 2 ))

  # Clamp to non-negative (safety)
  [ "$POPUP_X" -lt 0 ] && POPUP_X=0
  [ "$POPUP_Y" -lt 0 ] && POPUP_Y=0

  # Run popup — suppress the oh-my-tmux _split_window hook error by temporarily
  # unhooking after-split-window, then restoring it after the popup closes.
  # This prevents the cosmetic "returned 2" status-bar noise.
  EXISTING_HOOK="$(tmux show-hooks -g after-split-window 2>/dev/null | head -1 || true)"
  tmux set-hook -gu after-split-window 2>/dev/null || true

  tmux display-popup \
    -E \
    -w "${POPUP_W}" \
    -h "${POPUP_H}" \
    -x "${POPUP_X}" \
    -y "${POPUP_Y}" \
    -b "rounded" \
    -s "fg=#e6edf3,bg=#0d1117" \
    "sh" "-c" "${FZF_CMD}" 2>/dev/null || true

  # Restore hook if it existed
  if [ -n "$EXISTING_HOOK" ]; then
    tmux set-hook -g after-split-window "$EXISTING_HOOK" 2>/dev/null || true
  fi
else
  # Not in tmux — run fzf directly in the terminal
  eval "${FZF_CMD}" 2>/dev/null || true
fi

# Output the selection
if [ -s "$TMP_OUT" ]; then
  cat "$TMP_OUT"
  exit 0
else
  exit 1
fi
