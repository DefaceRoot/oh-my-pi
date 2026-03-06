#!/usr/bin/env bash
# Plan file picker — tmux popup fzf browser rooted at docs/plans/
# Usage:   plan-picker.sh <worktree_root> [title]
# Output:  absolute path to the selected plan file (stdout)
# Exit:    0 on selection, 1 on cancel or no files found

set -euo pipefail

WORKTREE_ROOT="${1:-$(pwd)}"
TITLE="${2:-Select Plan File}"
PLANS_DIR="${WORKTREE_ROOT}/docs/plans"

# Fall back to worktree root if docs/plans/ doesn't exist yet
[ -d "$PLANS_DIR" ] || PLANS_DIR="$WORKTREE_ROOT"

# Collect .md files (absolute paths, sorted newest-plan-first via path sort)
FILE_LIST="$(find "$PLANS_DIR" -type f -name "*.md" 2>/dev/null | sort -r)"

if [ -z "$FILE_LIST" ]; then
  echo "No plan files (.md) found under: $PLANS_DIR" >&2
  exit 1
fi

# Write file list to temp input file — tmux display-popup does NOT pipe stdin
# through to inner commands, so fzf must read from a file, not a pipe
TMP_IN="$(mktemp /tmp/omp-plan-in.XXXXXX)"
TMP_OUT="$(mktemp /tmp/omp-plan-out.XXXXXX)"
trap 'rm -f "$TMP_IN" "$TMP_OUT"' EXIT

# Display relative paths for readability; absolute paths stored for output
# Format: "relative/path.md  ←  absolute/path" — fzf shows relative, we extract absolute
while IFS= read -r absf; do
  # Strip worktree root prefix for display
  relf="${absf#${WORKTREE_ROOT}/}"
  printf '%s\t%s\n' "$relf" "$absf"
done <<< "$FILE_LIST" > "$TMP_IN"

# fzf colors: GitHub Dark, white border
FZF_COLORS="bg:#0d1117,bg+:#1c2128,fg:#cdd9e5,fg+:#ffffff"
FZF_COLORS="${FZF_COLORS},hl:#539bf5,hl+:#6bc7f6,header:#6e7681"
FZF_COLORS="${FZF_COLORS},border:#e6edf3,label:#539bf5,prompt:#57ab5a"
FZF_COLORS="${FZF_COLORS},pointer:#e5534b,info:#6e7681,separator:#21262d"

# Preview: show plan file content (bat if available, else head)
PREVIEW_CMD="abs=\$(awk -F'\t' '{print \$2}' <<< {}); bat --style=plain --color=always \"\$abs\" 2>/dev/null || head -40 \"\$abs\""

FZF_CMD="fzf"
FZF_CMD="${FZF_CMD} --border=rounded"
FZF_CMD="${FZF_CMD} --border-label=' ${TITLE} '"
FZF_CMD="${FZF_CMD} --border-label-pos=0"
FZF_CMD="${FZF_CMD} --padding=1,2"
FZF_CMD="${FZF_CMD} --prompt='  ❯  '"
FZF_CMD="${FZF_CMD} --pointer='▶'"
FZF_CMD="${FZF_CMD} --color='${FZF_COLORS}'"
FZF_CMD="${FZF_CMD} --bind='esc:abort,ctrl-c:abort'"
FZF_CMD="${FZF_CMD} --delimiter='\t'"
FZF_CMD="${FZF_CMD} --with-nth=1"          # display only relative path
FZF_CMD="${FZF_CMD} --no-sort"
FZF_CMD="${FZF_CMD} --info=inline"
FZF_CMD="${FZF_CMD} --preview='${PREVIEW_CMD}'"
FZF_CMD="${FZF_CMD} --preview-window='right:45%:wrap'"
FZF_CMD="${FZF_CMD} --bind='ctrl-/:toggle-preview'"
FZF_CMD="${FZF_CMD} --header='  ↑↓ navigate   Enter select   Ctrl-/ preview   Esc cancel'"
FZF_CMD="${FZF_CMD} --header-first"
FZF_CMD="${FZF_CMD} < '${TMP_IN}' > '${TMP_OUT}' 2>/dev/null"  # ← read from file, not TTY

if [ -n "${TMUX:-}" ]; then
  _PANE_GEOM="$(tmux display-message -p '#{pane_left} #{pane_top} #{pane_width} #{pane_height}')"
  PANE_LEFT="${_PANE_GEOM%% *}"; _PANE_GEOM="${_PANE_GEOM#* }"
  PANE_TOP="${_PANE_GEOM%% *}";  _PANE_GEOM="${_PANE_GEOM#* }"
  PANE_W="${_PANE_GEOM%% *}"
  PANE_H="${_PANE_GEOM##* }"

  POPUP_W=$(( PANE_W - 6 ))
  POPUP_H=$(( PANE_H - 4 ))
  [ "$POPUP_W" -lt 70 ] && POPUP_W=70
  [ "$POPUP_H" -lt 16 ] && POPUP_H=16
  [ "$POPUP_W" -gt 160 ] && POPUP_W=160

  POPUP_X=$(( PANE_LEFT + (PANE_W - POPUP_W) / 2 ))
  POPUP_Y=$(( PANE_TOP  + (PANE_H - POPUP_H) / 2 ))
  [ "$POPUP_X" -lt 0 ] && POPUP_X=0
  [ "$POPUP_Y" -lt 0 ] && POPUP_Y=0

  tmux display-popup -E \
    -w "${POPUP_W}" -h "${POPUP_H}" \
    -x "${POPUP_X}" -y "${POPUP_Y}" \
    -b "rounded" -s "fg=#e6edf3,bg=#0d1117" \
    "sh" "-c" "${FZF_CMD}" 2>/dev/null || true
else
  eval "${FZF_CMD}" 2>/dev/null || true
fi

# Extract the absolute path (tab-delimited column 2) from selected line
if [ -s "$TMP_OUT" ]; then
  awk -F'\t' '{print $2}' "$TMP_OUT"
  exit 0
else
  exit 1
fi
