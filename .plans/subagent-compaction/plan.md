# Subagent Compaction Plan

## Context

Oh My Pi already exposes parent/top-level context maintenance through `compaction.*` settings, and those parent session semantics must not change. The requested end state is a separate slash-settings/config surface for task subagents that can independently enable auto-compaction, choose the same compaction strategies as parent sessions, and set threshold percentage or fixed token limits. Subagent sessions must continue to be ordinary subagents: they keep their subagent identity, required `yield` return path, IRC/tool instructions, and orchestrator-owned result flow.

## Approach

1. Add a schema-backed Tasks tab group for subagent compaction controls.
   - In `packages/coding-agent/src/config/settings-schema.ts`, update `TAB_GROUPS.tasks` from `[
     "Modes", "Subagents", "Isolation", "Commands & Skills"
     ]` to exactly `[
     "Modes", "Subagents", "Subagent Compaction", "Isolation", "Commands & Skills"
     ]`. The new group is placed directly after existing subagent behavior settings and before isolation settings.
   - Extract the existing parent compaction strategy values/options and threshold option lists into top-level constants near the schema definition types, then reuse those constants for both parent and subagent settings. No existing reusable constants were found; this extraction prevents the two slash-settings selectors from drifting.
     - `COMPACTION_STRATEGY_VALUES` must be exactly `[
       "context-full", "handoff", "shake", "snapcompact", "off"
       ] as const`.
     - `COMPACTION_STRATEGY_OPTIONS` must preserve the existing parent option labels/descriptions:
       - `context-full`: label `Context-full`, description `Summarize in-place and keep the current session`
       - `handoff`: label `Handoff`, description `Generate handoff and continue in a new session`
       - `shake`: label `Shake`, description `Drop heavy content (tool results + large blocks) in place; recover via artifact`
       - `snapcompact`: label `Snapcompact`, description `Archive history onto dense bitmap images the model reads back; no LLM call`
       - `off`: label `Off`, description `Disable automatic context maintenance (same behavior as Auto-compact off)`
     - `COMPACTION_THRESHOLD_PERCENT_OPTIONS` must preserve the existing parent values: `default`, `10`, `20`, `30`, `40`, `50`, `60`, `70`, `75`, `80`, `85`, `90`, `95`, with the current labels/descriptions from `compaction.thresholdPercent`.
     - `COMPACTION_THRESHOLD_TOKEN_OPTIONS` must preserve the existing parent values: `default`, `25000`, `50000`, `100000`, `150000`, `200000`, `300000`, `500000`, with the current labels/descriptions from `compaction.thresholdTokens`.
   - Update existing parent `compaction.strategy`, `compaction.thresholdPercent`, and `compaction.thresholdTokens` definitions to use the constants above without changing their defaults, tab, group, labels, descriptions, values, or options.
   - Add `group: "Compaction"` to the existing `compaction.proactiveEnabled` UI metadata. This is a layout-contract fix only; do not change its default (`false`), label, description, or parent runtime behavior.

2. Add exactly five new user-facing subagent compaction settings to `SETTINGS_SCHEMA`.
   - Insert them with the other task/subagent settings, immediately after `task.softRequestBudget` and before hidden task settings such as `task.disabledAgents`.
   - Do not add `task.compaction.*` to `GroupTypeMap`; the runtime will read the five paths individually. `CompactionSettings` also stays unchanged because `AgentSession` continues to consume the existing `compaction.*` group.
   - Add these exact keys and metadata:
     - `task.compaction.enabled`
       - type `boolean`
       - default `true`
       - UI tab `tasks`, group `Subagent Compaction`
       - label `Subagent Auto-Compact`
       - description `Automatically compact subagent context when it gets too large`
     - `task.compaction.strategy`
       - type `enum`
       - values `COMPACTION_STRATEGY_VALUES`
       - default `context-full`
       - UI tab `tasks`, group `Subagent Compaction`
       - label `Subagent Compaction Strategy`
       - description `Choose in-place context-full maintenance, auto-handoff, surgical shake (drop heavy content), snapcompact (archive history as dense images), or disable subagent auto maintenance (off)`
       - options `COMPACTION_STRATEGY_OPTIONS`
     - `task.compaction.proactiveEnabled`
       - type `boolean`
       - default `false`
       - UI tab `tasks`, group `Subagent Compaction`
       - label `Subagent Proactive Compaction`
       - description `Compact subagents mid-loop at the next safe turn boundary once the threshold is reached, instead of waiting for the subagent to stop.`
     - `task.compaction.thresholdPercent`
       - type `number`
       - default `-1`
       - UI tab `tasks`, group `Subagent Compaction`
       - label `Subagent Compaction Threshold`
       - description `Percent threshold for subagent context maintenance; set to Default to use legacy reserve-based behavior`
       - options `COMPACTION_THRESHOLD_PERCENT_OPTIONS`
     - `task.compaction.thresholdTokens`
       - type `number`
       - default `-1`
       - UI tab `tasks`, group `Subagent Compaction`
       - label `Subagent Compaction Token Limit`
       - description `Fixed token limit for subagent context maintenance; overrides percentage if set`
       - options `COMPACTION_THRESHOLD_TOKEN_OPTIONS`
   - These defaults intentionally make subagents independent from parent values: subagent threshold auto-compaction is enabled by default with `context-full`, while proactive subagent compaction remains opt-in just like parent proactive compaction.

3. Teach the slash settings selector that subagent threshold selectors use the same `default` sentinel as parent threshold selectors.
   - In `packages/coding-agent/src/modes/components/settings-selector.ts`, replace the two hard-coded threshold path checks in `#getSubmenuCurrentValue()` and `#setSettingValue()` with one local helper near those methods:
     ```ts
     function usesDefaultThresholdSentinel(path: SettingPath): boolean {
      	return (
      		path === "compaction.thresholdPercent" ||
      		path === "compaction.thresholdTokens" ||
      		path === "task.compaction.thresholdPercent" ||
      		path === "task.compaction.thresholdTokens"
      	);
     }
     ```
   - `#getSubmenuCurrentValue(path, value)` must return `"default"` when `usesDefaultThresholdSentinel(path)` is true and the raw value is `"-1"` or `""`; otherwise it returns `String(value ?? "")` as it does today.
   - `#setSettingValue(path, value)` must store `-1` when `usesDefaultThresholdSentinel(path)` is true and `value === "default"`; otherwise it keeps the existing numeric/boolean/string conversion order. This prevents the new `task.compaction.thresholdPercent` and `task.compaction.thresholdTokens` slash selectors from storing `Number("default")` (`NaN`).

4. Map subagent-only settings onto the existing compaction group only inside isolated subagent settings.
   - In `packages/coding-agent/src/task/executor.ts`, update `createSubagentSettings(baseSettings, overrides?)` and no `AgentSession` compaction method. The current compaction hooks in `packages/coding-agent/src/session/agent-session.ts` already read `this.settings.getGroup("compaction")` dynamically in proactive, pre-prompt, post-turn threshold, and auto-compaction paths.
   - Preserve the existing snapshot loop over every `SETTINGS_SCHEMA` key. After building `snapshot` and before the existing forced headless overrides, add a `subagentCompactionOverrides` object with exactly these mappings:
     ```ts
     const subagentCompactionOverrides: Partial<Record<SettingPath, unknown>> = {
      	"compaction.enabled": baseSettings.get("task.compaction.enabled"),
      	"compaction.strategy": baseSettings.get("task.compaction.strategy"),
      	"compaction.proactiveEnabled": baseSettings.get("task.compaction.proactiveEnabled"),
      	"compaction.thresholdPercent": baseSettings.get("task.compaction.thresholdPercent"),
      	"compaction.thresholdTokens": baseSettings.get("task.compaction.thresholdTokens"),
     };
     ```
   - Spread order in `Settings.isolated()` must be exactly: `...snapshot`, `...subagentCompactionOverrides`, existing forced subagent overrides (`"async.enabled": false`, `"bash.autoBackground.enabled": false`, `"tools.approvalMode": "yolo"`), then the existing `...overrides` parameter. This preserves the current per-agent `read.summarize.enabled` override behavior and keeps the forced subagent execution settings unchanged.
   - Do not branch on `taskDepth` in `AgentSession`. Parent/top-level sessions continue to read their own `compaction.*` settings directly, and only `runSubprocess()`-created isolated settings receive the `task.compaction.*` remap.
   - Leave all non-exposed compaction internals inherited from the parent snapshot for subagents: `compaction.reserveTokens`, `compaction.keepRecentTokens`, `compaction.autoContinue`, `compaction.remoteEnabled`, `compaction.remoteEndpoint`, `compaction.handoffSaveToDisk`, `compaction.supersedeReads`, `compaction.dropUseless`, and idle compaction settings. The five new task settings are the only subagent-specific overrides in this change.

5. Add tests that prove schema/UI exposure and runtime isolation.
   - Extend `packages/coding-agent/test/settings-schema.test.ts` with a test named `exposes subagent compaction controls under task settings`.
     - Assert all five `task.compaction.*` keys exist in `SETTINGS_SCHEMA`.
     - Assert defaults exactly: `enabled === true`, `strategy === "context-full"`, `proactiveEnabled === false`, `thresholdPercent === -1`, `thresholdTokens === -1`.
     - Assert every new key has `getUi(path)?.tab === "tasks"` and `getUi(path)?.group === "Subagent Compaction"`.
     - Assert `SETTINGS_SCHEMA["task.compaction.strategy"].values` equals `SETTINGS_SCHEMA["compaction.strategy"].values`.
     - Assert each new path appears in `getPathsForTab("tasks")`, and the five paths appear in the schema order listed in step 2.
   - Do not remove `packages/coding-agent/test/modes/components/settings-layout.test.ts`; it should pass once `TAB_GROUPS.tasks` includes `Subagent Compaction` and every UI setting has a registered group.
   - Extend `packages/coding-agent/test/modes/components/settings-selector-memory-refresh.test.ts` using its existing `SettingsSelectorComponent` in-memory harness; do not create a second selector test file.
     - Add a helper in that test file that starts global settings search by typing a query, presses Enter to open the selected setting, presses Up once to move from the first concrete threshold option to `Default`, then presses Enter to save.
     - Add a test named `stores default for subagent compaction threshold selectors as the sentinel value`.
     - Initialize in-memory settings, set `settings.set("task.compaction.thresholdTokens", 25000)`, search for the exact label text `subagent compaction token limit`, select `Default`, and assert `settings.get("task.compaction.thresholdTokens") === -1`.
     - In the same test, set `settings.set("task.compaction.thresholdPercent", 10)`, search for the exact label text `subagent compaction threshold`, select `Default`, and assert `settings.get("task.compaction.thresholdPercent") === -1`.
     - The observable contract is the slash-settings selector persisting the `default` menu choice as `-1`, not merely rendering the option.
   - Extend `packages/coding-agent/test/task/executor-subagent-reminders.test.ts` using its existing `mockCreateAgentSession`, `createMockSession`, and `baseOptions` pattern.
     - Add a test named `maps subagent compaction controls onto isolated session settings`.
     - Create a parent settings instance with conflicting parent and subagent values:
       ```ts
       const parentSettings = Settings.isolated({
        	"compaction.enabled": true,
        	"compaction.proactiveEnabled": false,
        	"compaction.thresholdTokens": 999_999,
        	"compaction.thresholdPercent": 90,
        	"compaction.strategy": "handoff",
        	"task.compaction.enabled": false,
        	"task.compaction.proactiveEnabled": true,
        	"task.compaction.thresholdTokens": 12_345,
        	"task.compaction.thresholdPercent": 42,
        	"task.compaction.strategy": "shake",
       });
       ```
     - Run `runSubprocess({ ...baseOptions, id: "subagent-compaction-settings", settings: parentSettings })` with a mocked session that emits a successful `yield` tool event, then inspect `createAgentSessionSpy.mock.calls[0]?.[0]?.settings`.
     - Assert the created subagent settings return `false`, `true`, `12_345`, `42`, and `"shake"` for `compaction.enabled`, `compaction.proactiveEnabled`, `compaction.thresholdTokens`, `compaction.thresholdPercent`, and `compaction.strategy` respectively.
     - Assert the original `parentSettings` still returns its conflicting parent values for all five `compaction.*` paths, proving parent/top-level settings were not mutated.
     - In the same assertion block, confirm the subagent identity/return contract options remain present: `requireYieldTool === true`, `agentId === "subagent-compaction-settings"`, `parentTaskPrefix === "subagent-compaction-settings"`, and `taskDepth` is greater than `0`.

6. Update the package changelog after the behavior and focused tests pass.
   - In `packages/coding-agent/CHANGELOG.md`, add one `## [Unreleased]` / `### Added` bullet: `Added separate subagent compaction settings so task agents can use their own auto-compact strategy and thresholds without changing parent session compaction.`
   - Do not modify released sections.

## Critical files & anchors

- `packages/coding-agent/src/config/settings-schema.ts` — `TAB_GROUPS`, existing `compaction.*` definitions, and task/subagent settings around `task.softRequestBudget`; this is the single schema source used by slash settings.
- `packages/coding-agent/src/modes/components/settings-selector.ts` — `#getSubmenuCurrentValue()` and `#setSettingValue()` currently special-case only parent compaction threshold sentinels.
- `packages/coding-agent/src/task/executor.ts` — `createSubagentSettings()` is the subagent-only settings seam; `runSubprocess()` passes its result to `createAgentSession()`.
- `packages/coding-agent/test/task/executor-subagent-reminders.test.ts` — existing `createAgentSession` spy and mocked subagent session pattern for proving runtime settings are passed to subagents.
- `packages/coding-agent/test/modes/components/settings-selector-memory-refresh.test.ts` — existing `SettingsSelectorComponent` in-memory harness for exercising slash-settings interactions without launching the full TUI.

## Verification

Run these from the repository root after implementation:

1. Focused behavior tests:
   ```sh
   bun --cwd=packages/coding-agent test test/settings-schema.test.ts test/modes/components/settings-layout.test.ts test/modes/components/settings-selector-memory-refresh.test.ts test/task/executor-subagent-reminders.test.ts
   ```
   Expected result: all listed tests pass. The new executor test must show a subagent spawned from conflicting parent settings receives `compaction.*` values from `task.compaction.*`, while the parent settings object keeps its original `compaction.*` values.

2. Type check the changed package:
   ```sh
   bun --cwd=packages/coding-agent run check:types
   ```
   Expected result: no TypeScript errors from the new schema paths, option constants, selector helper, or executor mapping.

3. Manual slash-settings smoke check only if the selector interaction test cannot be made deterministic with the existing harness:
   - Start `omp`, open `/settings`, go to the `Tasks` tab, and confirm a `Subagent Compaction` group appears after `Subagents` and before `Isolation`.
   - Open `Subagent Compaction Token Limit`, select `Default`, and confirm the backing setting is `-1` by reading the persisted config or by a focused test assertion. The selector must not store `NaN`.

## Assumptions & contingencies

- The first implementation exposes only the five controls explicitly requested for subagents. Subagent compaction internals that are not exposed continue to come from the parent snapshot/defaults, so existing tuning such as reserve tokens, keep-recent tokens, remote compaction, and pruning behavior does not gain a second configuration surface in this change.
- `handoff` remains a valid subagent strategy because the requested selector must offer the same strategy literals as parent compaction. If a subagent-specific handoff lifecycle bug appears while implementing or testing, fix that lifecycle path while preserving the `handoff` literal; do not remove or hide `handoff` from `task.compaction.strategy`.
- If the selector interaction test is brittle because exact search-result activation changes, keep the same observable assertion (`Default` selected through `SettingsSelectorComponent` stores `-1` for both new task threshold paths) and adjust only the test navigation helper. Do not replace it with a schema-only test, because schema checks do not cover the `Number("default")` failure path in the slash-settings selector.
