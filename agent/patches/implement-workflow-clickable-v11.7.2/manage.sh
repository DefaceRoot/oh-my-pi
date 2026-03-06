#!/usr/bin/env bash
set -euo pipefail

PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
FILES_DIR="$PATCH_DIR/files"
BUN_GLOBAL="/home/colin/.bun/install/global/node_modules/@oh-my-pi"
TARGET_TUI="$BUN_GLOBAL/pi-tui"
TARGET_AGENT="$BUN_GLOBAL/pi-coding-agent"
TARGET_AI="$BUN_GLOBAL/pi-ai"
TARGET_AGENT_CORE="$BUN_GLOBAL/pi-agent-core"
EXPECTED_VERSION_PREFIX="13"

usage() {
  cat <<'EOF'
Usage: manage.sh <status|apply|restore> [--force]

Commands:
  status   Check whether clickable implement workflow patch markers are present
  apply    Apply packaged patched files into global OMP install
  restore  Restore most recent backup created by apply

Options:
  --force  Skip version mismatch check during apply
EOF
}

version_of() {
  local pkg_json="$1/package.json"
  if [[ ! -f "$pkg_json" ]]; then
    echo "missing"
    return
  fi
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg_json" | head -n 1
}

assert_exists() {
  local p="$1"
  if [[ ! -e "$p" ]]; then
    echo "ERROR: missing path: $p" >&2
    exit 1
  fi
}

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    cp "$src" "$dst"
  fi
}

restore_from_dir() {
  local source_dir="$1"

  cp "$source_dir/pi-tui/src/terminal.ts" "$TARGET_TUI/src/terminal.ts"
  cp "$source_dir/pi-tui/src/tui.ts" "$TARGET_TUI/src/tui.ts"
  cp "$source_dir/pi-tui/src/index.ts" "$TARGET_TUI/src/index.ts"
  cp "$source_dir/pi-coding-agent/src/modes/interactive-mode.ts" "$TARGET_AGENT/src/modes/interactive-mode.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/modes/types.ts" "$TARGET_AGENT/src/modes/types.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/modes/components/custom-editor.ts" "$TARGET_AGENT/src/modes/components/custom-editor.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/modes/controllers/input-controller.ts" "$TARGET_AGENT/src/modes/controllers/input-controller.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/modes/controllers/event-controller.ts" "$TARGET_AGENT/src/modes/controllers/event-controller.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/modes/controllers/command-controller.ts" "$TARGET_AGENT/src/modes/controllers/command-controller.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/modes/controllers/selector-controller.ts" "$TARGET_AGENT/src/modes/controllers/selector-controller.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/modes/components/model-selector.ts" "$TARGET_AGENT/src/modes/components/model-selector.ts"
  cp "$source_dir/pi-coding-agent/src/modes/components/status-line.ts" "$TARGET_AGENT/src/modes/components/status-line.ts"
  cp "$source_dir/pi-coding-agent/src/modes/components/status-line/segments.ts" "$TARGET_AGENT/src/modes/components/status-line/segments.ts"
  cp "$source_dir/pi-coding-agent/src/task/agents.ts" "$TARGET_AGENT/src/task/agents.ts"
  cp "$source_dir/pi-coding-agent/src/config/model-registry.ts" "$TARGET_AGENT/src/config/model-registry.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/config/keybindings.ts" "$TARGET_AGENT/src/config/keybindings.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/config/settings-schema.ts" "$TARGET_AGENT/src/config/settings-schema.ts"
  cp "$source_dir/pi-coding-agent/src/task/index.ts" "$TARGET_AGENT/src/task/index.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/task/executor.ts" "$TARGET_AGENT/src/task/executor.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/task/render.ts" "$TARGET_AGENT/src/task/render.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/tools/index.ts" "$TARGET_AGENT/src/tools/index.ts"
  copy_if_exists "$source_dir/pi-coding-agent/src/tools/submit-result.ts" "$TARGET_AGENT/src/tools/submit-result.ts"
  copy_if_exists "$source_dir/pi-ai/src/utils/typebox-helpers.ts" "$TARGET_AI/src/utils/typebox-helpers.ts"
  copy_if_exists "$source_dir/pi-agent-core/src/agent-loop.ts" "$TARGET_AGENT_CORE/src/agent-loop.ts"
}

run_smoke_check() {
  local check_script
  check_script='const files = [
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/terminal.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/tui.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/index.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/interactive-mode.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/types.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/components/custom-editor.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/controllers/input-controller.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/controllers/event-controller.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/controllers/command-controller.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/controllers/selector-controller.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/components/status-line.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/components/status-line/segments.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-registry.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/keybindings.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/settings-schema.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/task/agents.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/task/index.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/task/executor.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/task/render.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/tools/index.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/tools/submit-result.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-ai/src/utils/typebox-helpers.ts",
    "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-agent-core/src/agent-loop.ts"
  ];
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const filePath of files) {
    const file = Bun.file(filePath);
    if (!(await file.exists())) continue;
    const source = await file.text();
    transpiler.transformSync(source);
  }'

  # Parse-only check (TypeScript syntax)
  bun -e "$check_script" >/dev/null 2>&1 || return 1

  # Runtime link check (catches missing named exports after upstream upgrades)
  bun -e '(async () => {
    const requiredImports = [
      "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-registry.ts",
      "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/tools/index.ts",
      "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/interactive-mode.ts",
      "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/task/render.ts",
      "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-tui/src/tui.ts"
    ];
    for (const filePath of requiredImports) {
      try {
        await import(filePath);
      } catch (error) {
        console.error(`[smoke] import failed: ${filePath}`);
        throw error;
      }
    }
    const aiTypeboxHelpers = "/home/colin/.bun/install/global/node_modules/@oh-my-pi/pi-ai/src/utils/typebox-helpers.ts";
    if (await Bun.file(aiTypeboxHelpers).exists()) {
      try {
        await import(aiTypeboxHelpers);
      } catch (error) {
        console.error(`[smoke] import failed: ${aiTypeboxHelpers}`);
        throw error;
      }
    }
  })();' || return 1

  status >/dev/null 2>&1 || return 1
}

status() {
  assert_exists "$TARGET_TUI/src/terminal.ts"
  assert_exists "$TARGET_TUI/src/tui.ts"
  assert_exists "$TARGET_AGENT/src/modes/interactive-mode.ts"
  assert_exists "$TARGET_AGENT/src/modes/types.ts"
  assert_exists "$TARGET_AGENT/src/modes/components/custom-editor.ts"
  assert_exists "$TARGET_AGENT/src/modes/controllers/input-controller.ts"
  assert_exists "$TARGET_AGENT/src/modes/controllers/event-controller.ts"
  assert_exists "$TARGET_AGENT/src/modes/controllers/command-controller.ts"
  assert_exists "$TARGET_AGENT/src/modes/controllers/selector-controller.ts"
  assert_exists "$TARGET_AGENT/src/modes/components/status-line.ts"
  assert_exists "$TARGET_AGENT/src/modes/components/status-line/segments.ts"
  assert_exists "$TARGET_AGENT/src/config/model-registry.ts"
  assert_exists "$TARGET_AGENT/src/config/keybindings.ts"
  assert_exists "$TARGET_AGENT/src/config/settings-schema.ts"
  assert_exists "$TARGET_AGENT/src/task/agents.ts"
  assert_exists "$TARGET_AGENT/src/task/index.ts"
  assert_exists "$TARGET_AGENT/src/task/executor.ts"
  assert_exists "$TARGET_AGENT/src/task/render.ts"
  assert_exists "$TARGET_AGENT/src/tools/index.ts"
  assert_exists "$TARGET_AGENT/src/tools/submit-result.ts"

  local ai_typebox_helpers="$TARGET_AI/src/utils/typebox-helpers.ts"
  local ok=1

  if ! grep -Fq '?1000h\x1b[?1003h\x1b[?1006h' "$TARGET_TUI/src/terminal.ts"; then
    echo "[missing] mouse enable in pi-tui terminal.ts"
    ok=0
  else
    echo "[ok] mouse enable in pi-tui terminal.ts"
  fi

  if ! grep -q 'parseSgrMouseEvent' "$TARGET_TUI/src/tui.ts"; then
    echo "[missing] SGR mouse parser in pi-tui tui.ts"
    ok=0
  else
    echo "[ok] SGR mouse parser in pi-tui tui.ts"
  fi

  if ! grep -Fq 'public onMouse?: (event: TerminalMouseEvent)' "$TARGET_TUI/src/tui.ts"; then
    echo "[missing] onMouse callback in pi-tui tui.ts"
    ok=0
  else
    echo "[ok] onMouse callback in pi-tui tui.ts"
  fi

  if ! grep -q 'handleFooterMouseClick' "$TARGET_AGENT/src/modes/interactive-mode.ts"; then
    echo "[missing] footer click handler in interactive-mode.ts"
    ok=0
  else
    echo "[ok] footer click handler in interactive-mode.ts"
  fi

  if ! grep -q 'ACTION_BUTTONS: ActionButtonUi\[]' "$TARGET_AGENT/src/modes/interactive-mode.ts"; then
    echo "[missing] action button marker in interactive-mode.ts"
    ok=0
  else
    echo "[ok] action button marker in interactive-mode.ts"
  fi

  if ! grep -q 'PLAN_WORKFLOW_STATUS_KEY' "$TARGET_AGENT/src/modes/interactive-mode.ts"; then
    echo "[missing] dual-button plan/implement status key support in interactive-mode.ts"
    ok=0
  else
    echo "[ok] dual-button plan/implement status key support in interactive-mode.ts"
  fi

  if ! grep -q '/delete-worktree' "$TARGET_AGENT/src/modes/interactive-mode.ts"; then
    echo "[missing] delete-worktree footer action in interactive-mode.ts"
    ok=0
  else
    echo "[ok] delete-worktree footer action in interactive-mode.ts"
  fi

  if ! grep -q '/review-complete' "$TARGET_AGENT/src/modes/interactive-mode.ts"; then
    echo "[missing] review-complete footer action in interactive-mode.ts"
    ok=0
  else
    echo "[ok] review-complete footer action in interactive-mode.ts"
  fi

  if ! grep -q '/fix-issues' "$TARGET_AGENT/src/modes/interactive-mode.ts"; then
    echo "[missing] fix-issues footer action in interactive-mode.ts"
    ok=0
  else
    echo "[ok] fix-issues footer action in interactive-mode.ts"
  fi

  if ! grep -q '/update-version-workflow' "$TARGET_AGENT/src/modes/interactive-mode.ts"; then
    echo "[missing] update-version footer action in interactive-mode.ts"
    ok=0
  else
    echo "[ok] update-version footer action in interactive-mode.ts"
  fi

  if ! grep -q 'cycleSubagentView' "$TARGET_AGENT/src/modes/interactive-mode.ts"; then
    echo "[missing] subagent transcript cycle method in interactive-mode.ts"
    ok=0
  else
    echo "[ok] subagent transcript cycle method in interactive-mode.ts"
  fi

  if ! grep -q 'cycleSubagentForward' "$TARGET_AGENT/src/config/keybindings.ts"; then
    echo "[missing] subagent cycle keybindings in keybindings.ts"
    ok=0
  else
    echo "[ok] subagent cycle keybindings in keybindings.ts"
  fi

  if ! grep -q 'prevent stale viewport artifacts' "$TARGET_AGENT/src/config/settings-schema.ts"; then
    echo "[missing] clearOnShrink default-on rendering fix in settings-schema.ts"
    ok=0
  else
    echo "[ok] clearOnShrink default-on rendering fix in settings-schema.ts"
  fi

  if ! grep -q 'cycleSubagentForward' "$TARGET_AGENT/src/modes/controllers/input-controller.ts"; then
    echo "[missing] subagent cycle key wiring in input-controller.ts"
    ok=0
  else
    echo "[ok] subagent cycle key wiring in input-controller.ts"
  fi

  if ! grep -q 'handled !== false' "$TARGET_AGENT/src/modes/components/custom-editor.ts"; then
    echo "[missing] passthrough custom key handling in custom-editor.ts"
    ok=0
  else
    echo "[ok] passthrough custom key handling in custom-editor.ts"
  fi

  if ! grep -q 'Cycle subagent transcripts' "$TARGET_AGENT/src/modes/controllers/command-controller.ts"; then
    echo "[missing] hotkeys help for subagent cycle in command-controller.ts"
    ok=0
  else
    echo "[ok] hotkeys help for subagent cycle in command-controller.ts"
  fi

  if ! grep -q 'ThinkingLevelSelectorComponent' "$TARGET_AGENT/src/modes/controllers/selector-controller.ts"; then
    echo "[missing] thinking-level picker in selector-controller.ts"
    ok=0
  else
    echo "[ok] thinking-level picker in selector-controller.ts"
  fi

  if ! grep -q 'writeModelRoleThinkingLevel' "$TARGET_AGENT/src/modes/controllers/selector-controller.ts"; then
    echo "[missing] per-role thinking level persistence in selector-controller.ts"
    ok=0
  else
    echo "[ok] per-role thinking level persistence in selector-controller.ts"
  fi

  if ! grep -q 'MODEL_ROLE_IDS' "$TARGET_AGENT/src/modes/components/model-selector.ts" 2>/dev/null; then
    echo "[missing] all-roles model selector in model-selector.ts"
    ok=0
  else
    echo "[ok] all-roles model selector in model-selector.ts"
  fi

  if [[ -f "$TARGET_AGENT/src/modes/controllers/extension-ui-controller.ts" ]]; then
    if grep -q 'setModelTemporary' "$TARGET_AGENT/src/modes/controllers/extension-ui-controller.ts"; then
      echo "[ok] setModelTemporary in extension-ui-controller.ts (model persistence fix)"
    else
      echo "[skip] setModelTemporary check (not present in this OMP version)"
    fi
  else
    echo "[skip] setModelTemporary check (extension-ui-controller.ts not present)"
  fi

  if ! grep -q 'suppressChatMutationsInSubagentView' "$TARGET_AGENT/src/modes/controllers/event-controller.ts"; then
    echo "[missing] subagent-view chat suppression in event-controller.ts"
    ok=0
  else
    echo "[ok] subagent-view chat suppression in event-controller.ts"
  fi

  if ! grep -q 'const liveCwd = process.cwd()' "$TARGET_AGENT/src/task/index.ts"; then
    echo "[missing] subagent cwd inheritance fix in task/index.ts"
    ok=0
  else
    echo "[ok] subagent cwd inheritance fix in task/index.ts"
  fi

  if ! grep -q 'const subagentRole = resolveSubagentRole(effectiveAgent.name);' "$TARGET_AGENT/src/task/index.ts"; then
    echo "[missing] explore/research/subagent role model selection in task/index.ts"
    ok=0
  else
    echo "[ok] explore/research/subagent role model selection in task/index.ts"
  fi

  if ! grep -q 'resolveSubagentRuntimeOverrides' "$TARGET_AGENT/src/task/index.ts"; then
    echo "[missing] live subagent model resolution in task/index.ts"
    ok=0
  else
    echo "[ok] live subagent model resolution in task/index.ts"
  fi

  if ! grep -q 'Explore fan-out limit exceeded' "$TARGET_AGENT/src/task/index.ts"; then
    echo "[missing] explore fan-out cap in task/index.ts"
    ok=0
  else
    echo "[ok] explore fan-out cap in task/index.ts"
  fi

  if ! grep -q 'Use uncached tokens for progress and UI counts' "$TARGET_AGENT/src/task/executor.ts"; then
    echo "[missing] uncached subagent token counting in task/executor.ts"
    ok=0
  else
    echo "[ok] uncached subagent token counting in task/executor.ts"
  fi

	if ! grep -q 'hasUI: false' "$TARGET_AGENT/src/task/executor.ts"; then
	  echo "[missing] autonomous subagent headless mode in task/executor.ts"
    ok=0
  else
	  echo "[ok] autonomous subagent headless mode in task/executor.ts"
  fi


  if grep -q 'status MUST be a string literal: "success" or "aborted"' "$TARGET_AGENT/src/task/executor.ts"; then
    echo "[missing] submit_result reminder still uses deprecated status/data contract in task/executor.ts"
    ok=0
  else
    echo "[ok] submit_result reminder avoids deprecated status/data contract in task/executor.ts"
  fi

  if ! grep -q 'result MUST contain exactly one of data or error' "$TARGET_AGENT/src/task/executor.ts"; then
    echo "[missing] submit_result reminder uses result.data/result.error contract in task/executor.ts"
    ok=0
  else
    echo "[ok] submit_result reminder uses result.data/result.error contract in task/executor.ts"
  fi

  if ! grep -q 'SUBMIT_RESULT_ONLY_PROMPT_TIMEOUT_MS = 90_000' "$TARGET_AGENT/src/task/executor.ts"; then
    echo "[missing] submit_result reminder timeout bump to 90s in task/executor.ts"
    ok=0
  else
    echo "[ok] submit_result reminder timeout bump to 90s in task/executor.ts"
  fi
  if ! grep -Fq 'const tasks = Array.isArray(safeArgs.tasks) ? safeArgs.tasks : [];' "$TARGET_AGENT/src/task/render.ts"; then
    echo "[missing] defensive task renderer args guard in task/render.ts"
    ok=0
  else
    echo "[ok] defensive task renderer args guard in task/render.ts"
  fi
  # Keep upstream tools/index.ts on newer OMP builds; patched copy is stale for 13.5.x.

  if ! grep -q 'data: Type.Optional(dataSchema)' "$TARGET_AGENT/src/tools/submit-result.ts"; then
    echo "[missing] strict-compatible submit_result result schema in tools/submit-result.ts"
    ok=0
  else
    echo "[ok] strict-compatible submit_result result schema in tools/submit-result.ts"
  fi

  if ! grep -q 'extractUncachedUsageTokens' "$TARGET_AGENT/src/modes/interactive-mode.ts"; then
    echo "[missing] uncached token extraction in interactive-mode.ts"
    ok=0
  else
    echo "[ok] uncached token extraction in interactive-mode.ts"
  fi

  if ! grep -q 'thinkingLevel: "high"' "$TARGET_AGENT/src/task/agents.ts"; then
    echo "[missing] default high thinking level for bundled task subagent"
    ok=0
  else
    echo "[ok] default high thinking level for bundled task subagent"
  fi

  if ! grep -q 'subagent: { tag: "IMPL"' "$TARGET_AGENT/src/config/model-registry.ts"; then
    echo "[missing] subagent role in model-registry.ts"
    ok=0
  else
    echo "[ok] subagent role in model-registry.ts"
  fi

 	if ! grep -q 'orchestrator: { tag: "ORCHESTRATOR"' "$TARGET_AGENT/src/config/model-registry.ts"; then
	  echo "[missing] orchestrator role in model-registry.ts"
    ok=0
  else
	  echo "[ok] orchestrator role in model-registry.ts"
  fi

  if ! grep -q 'explore: { tag: "EXPLORE"' "$TARGET_AGENT/src/config/model-registry.ts"; then
    echo "[missing] explore role in model-registry.ts"
	  ok=0
 	else
    echo "[ok] explore role in model-registry.ts"
  fi

  if ! grep -q 'readWorktreeHeadPath' "$TARGET_AGENT/src/modes/components/status-line.ts"; then
    echo "[missing] worktree HEAD resolution fix in status-line.ts"
    ok=0
  else
    echo "[ok] worktree HEAD resolution fix in status-line.ts"
  fi

  if ! grep -q 'formatDisplayedPath' "$TARGET_AGENT/src/modes/components/status-line/segments.ts"; then
    echo "[missing] worktree path display compaction in segments.ts"
    ok=0
  else
    echo "[ok] worktree path display compaction in segments.ts"
  fi

  if ! grep -q 'getModelRole("default")' "$TARGET_AGENT/src/modes/components/status-line/segments.ts" 2>/dev/null; then
    echo "[missing] default-before-orchestrator role check in segments.ts"
    ok=0
  else
    echo "[ok] default-before-orchestrator role check in segments.ts"
  fi

  if [[ -f "$ai_typebox_helpers" ]]; then
    if ! grep -q 'result.type === "array" && !Object.hasOwn(result, "items")' "$ai_typebox_helpers"; then
      echo "[missing] strict array items fallback in pi-ai typebox-helpers.ts"
      ok=0
    else
      echo "[ok] strict array items fallback in pi-ai typebox-helpers.ts"
    fi
  else
    echo "[skip] strict array items fallback check (pi-ai typebox-helpers.ts not present in this OMP version)"
  fi

  if [[ -f "$TARGET_AGENT_CORE/src/agent-loop.ts" ]]; then
    if grep -q 'Abort-before-LLM guard' "$TARGET_AGENT_CORE/src/agent-loop.ts"; then
      echo "[ok] abort-before-LLM guard in pi-agent-core agent-loop.ts"
    else
      echo "[skip] abort-before-LLM guard check (not present in this OMP version)"
    fi
  else
    echo "[skip] abort-before-LLM guard check (pi-agent-core agent-loop.ts not present)"
  fi

  if [[ "$ok" -eq 1 ]]; then
    echo "\nPatch status: INSTALLED"
  else
    echo "\nPatch status: NOT INSTALLED (or partially installed)"
    exit 2
  fi
}

apply_patch() {
  local force="${1:-}"
  local tui_version
  local agent_version
  local ai_version

  tui_version="$(version_of "$TARGET_TUI")"
  agent_version="$(version_of "$TARGET_AGENT")"

  ai_version="$(version_of "$TARGET_AI")"
  if [[ "$force" != "--force" ]]; then
    if [[ "$tui_version" != "$EXPECTED_VERSION_PREFIX."* || "$agent_version" != "$EXPECTED_VERSION_PREFIX."* || "$ai_version" != "$EXPECTED_VERSION_PREFIX."* ]]; then
      echo "ERROR: version mismatch." >&2
      echo "  Expected prefix: ${EXPECTED_VERSION_PREFIX}.x" >&2
      echo "  Found pi-tui: $tui_version" >&2
      echo "  Found pi-coding-agent: $agent_version" >&2
      echo "  Found pi-ai: $ai_version" >&2
      echo "Re-run with --force if you intentionally want to apply anyway." >&2
      exit 1
    fi
  fi

  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  local backup_dir="$PATCH_DIR/backups/$stamp"
  mkdir -p "$backup_dir/pi-tui/src" "$backup_dir/pi-coding-agent/src/modes" "$backup_dir/pi-coding-agent/src/modes/controllers" "$backup_dir/pi-coding-agent/src/modes/components" "$backup_dir/pi-coding-agent/src/modes/components/status-line" "$backup_dir/pi-coding-agent/src/task" "$backup_dir/pi-coding-agent/src/config" "$backup_dir/pi-coding-agent/src/tools" "$backup_dir/pi-ai/src/utils" "$backup_dir/pi-agent-core/src"

  cp "$TARGET_TUI/src/terminal.ts" "$backup_dir/pi-tui/src/terminal.ts"
  cp "$TARGET_TUI/src/tui.ts" "$backup_dir/pi-tui/src/tui.ts"
  cp "$TARGET_TUI/src/index.ts" "$backup_dir/pi-tui/src/index.ts"
  cp "$TARGET_AGENT/src/modes/interactive-mode.ts" "$backup_dir/pi-coding-agent/src/modes/interactive-mode.ts"
  cp "$TARGET_AGENT/src/modes/types.ts" "$backup_dir/pi-coding-agent/src/modes/types.ts"
  cp "$TARGET_AGENT/src/modes/components/custom-editor.ts" "$backup_dir/pi-coding-agent/src/modes/components/custom-editor.ts"
  cp "$TARGET_AGENT/src/modes/controllers/input-controller.ts" "$backup_dir/pi-coding-agent/src/modes/controllers/input-controller.ts"
  cp "$TARGET_AGENT/src/modes/controllers/event-controller.ts" "$backup_dir/pi-coding-agent/src/modes/controllers/event-controller.ts"
  cp "$TARGET_AGENT/src/modes/controllers/command-controller.ts" "$backup_dir/pi-coding-agent/src/modes/controllers/command-controller.ts"
  copy_if_exists "$TARGET_AGENT/src/modes/controllers/selector-controller.ts" "$backup_dir/pi-coding-agent/src/modes/controllers/selector-controller.ts"
  copy_if_exists "$TARGET_AGENT/src/modes/controllers/extension-ui-controller.ts" "$backup_dir/pi-coding-agent/src/modes/controllers/extension-ui-controller.ts"
  copy_if_exists "$TARGET_AGENT/src/modes/components/model-selector.ts" "$backup_dir/pi-coding-agent/src/modes/components/model-selector.ts"
  cp "$TARGET_AGENT/src/modes/components/status-line.ts" "$backup_dir/pi-coding-agent/src/modes/components/status-line.ts"
  cp "$TARGET_AGENT/src/modes/components/status-line/segments.ts" "$backup_dir/pi-coding-agent/src/modes/components/status-line/segments.ts"
  cp "$TARGET_AGENT/src/task/agents.ts" "$backup_dir/pi-coding-agent/src/task/agents.ts"
  cp "$TARGET_AGENT/src/config/model-registry.ts" "$backup_dir/pi-coding-agent/src/config/model-registry.ts"
  cp "$TARGET_AGENT/src/config/keybindings.ts" "$backup_dir/pi-coding-agent/src/config/keybindings.ts"
  cp "$TARGET_AGENT/src/config/settings-schema.ts" "$backup_dir/pi-coding-agent/src/config/settings-schema.ts"
  cp "$TARGET_AGENT/src/task/index.ts" "$backup_dir/pi-coding-agent/src/task/index.ts"
  cp "$TARGET_AGENT/src/task/executor.ts" "$backup_dir/pi-coding-agent/src/task/executor.ts"
  cp "$TARGET_AGENT/src/task/render.ts" "$backup_dir/pi-coding-agent/src/task/render.ts"
  cp "$TARGET_AGENT/src/tools/index.ts" "$backup_dir/pi-coding-agent/src/tools/index.ts"
  copy_if_exists "$TARGET_AGENT/src/tools/submit-result.ts" "$backup_dir/pi-coding-agent/src/tools/submit-result.ts"
  copy_if_exists "$TARGET_AI/src/utils/typebox-helpers.ts" "$backup_dir/pi-ai/src/utils/typebox-helpers.ts"

  cp "$FILES_DIR/pi-tui/src/terminal.ts" "$TARGET_TUI/src/terminal.ts"
  cp "$FILES_DIR/pi-tui/src/tui.ts" "$TARGET_TUI/src/tui.ts"
  cp "$FILES_DIR/pi-tui/src/index.ts" "$TARGET_TUI/src/index.ts"
  cp "$FILES_DIR/pi-coding-agent/src/modes/interactive-mode.ts" "$TARGET_AGENT/src/modes/interactive-mode.ts"
  cp "$FILES_DIR/pi-coding-agent/src/modes/types.ts" "$TARGET_AGENT/src/modes/types.ts"
  cp "$FILES_DIR/pi-coding-agent/src/modes/components/custom-editor.ts" "$TARGET_AGENT/src/modes/components/custom-editor.ts"
  cp "$FILES_DIR/pi-coding-agent/src/modes/controllers/input-controller.ts" "$TARGET_AGENT/src/modes/controllers/input-controller.ts"
  cp "$FILES_DIR/pi-coding-agent/src/modes/controllers/event-controller.ts" "$TARGET_AGENT/src/modes/controllers/event-controller.ts"
  cp "$FILES_DIR/pi-coding-agent/src/modes/controllers/command-controller.ts" "$TARGET_AGENT/src/modes/controllers/command-controller.ts"
  cp "$FILES_DIR/pi-coding-agent/src/modes/controllers/selector-controller.ts" "$TARGET_AGENT/src/modes/controllers/selector-controller.ts"
  copy_if_exists "$FILES_DIR/pi-coding-agent/src/modes/components/model-selector.ts" "$TARGET_AGENT/src/modes/components/model-selector.ts"
  cp "$FILES_DIR/pi-coding-agent/src/modes/components/status-line.ts" "$TARGET_AGENT/src/modes/components/status-line.ts"
  cp "$FILES_DIR/pi-coding-agent/src/modes/components/status-line/segments.ts" "$TARGET_AGENT/src/modes/components/status-line/segments.ts"
  cp "$FILES_DIR/pi-coding-agent/src/task/agents.ts" "$TARGET_AGENT/src/task/agents.ts"
  cp "$FILES_DIR/pi-coding-agent/src/config/model-registry.ts" "$TARGET_AGENT/src/config/model-registry.ts"
  cp "$FILES_DIR/pi-coding-agent/src/config/keybindings.ts" "$TARGET_AGENT/src/config/keybindings.ts"
  copy_if_exists "$FILES_DIR/pi-coding-agent/src/config/settings-schema.ts" "$TARGET_AGENT/src/config/settings-schema.ts"
  cp "$FILES_DIR/pi-coding-agent/src/task/index.ts" "$TARGET_AGENT/src/task/index.ts"
  cp "$FILES_DIR/pi-coding-agent/src/task/executor.ts" "$TARGET_AGENT/src/task/executor.ts"
  copy_if_exists "$FILES_DIR/pi-coding-agent/src/task/render.ts" "$TARGET_AGENT/src/task/render.ts"
  # Keep upstream tools/index.ts on newer OMP builds; patched copy is stale for 13.5.x.

  copy_if_exists "$FILES_DIR/pi-coding-agent/src/tools/submit-result.ts" "$TARGET_AGENT/src/tools/submit-result.ts"
  copy_if_exists "$FILES_DIR/pi-ai/src/utils/typebox-helpers.ts" "$TARGET_AI/src/utils/typebox-helpers.ts"
  if ! run_smoke_check; then
    echo "ERROR: smoke check failed after applying patch; restoring backup." >&2
    restore_from_dir "$backup_dir"
    echo "Restored files from backup: $backup_dir" >&2
    exit 1
  fi

  echo "Applied clickable implement workflow patch."
  echo "Backup created at: $backup_dir"
}

restore_patch() {
  local latest
  latest="$(find "$PATCH_DIR/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1 || true)"
  if [[ -z "$latest" ]]; then
    echo "ERROR: no backups found under $PATCH_DIR/backups" >&2
    exit 1
  fi

  restore_from_dir "$latest"

  echo "Restored files from backup: $latest"
}

cmd="${1:-}"
arg="${2:-}"

case "$cmd" in
  status)
    status
    ;;
  apply)
    apply_patch "$arg"
    ;;
  restore)
    restore_patch
    ;;
  *)
    usage
    exit 1
    ;;
esac
