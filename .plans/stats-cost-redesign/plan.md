# Stats cost redesign plan

## Context

`omp stats` currently reads recorded session usage but treats zero-cost proxy/subscription rows as zero dollars, so CLIProxyAPI/model-proxy sessions that contain real token counts can under-report cost. The stats dashboard also requires a manual sync to ingest new harness sessions and uses a dense, rainbow/gradient UI that hides small dollar values as `$0`. The intended end state is: stats rows keep provider-reported nonzero cost, zero-cost rows get API-equivalent catalog cost when their model id can be resolved to a bundled upstream model, the dashboard refresh path triggers sync automatically, harness launch/shutdown opportunistically syncs stats without writing to stdout/stderr, and the React dashboard is calmer, more accessible, and clearer about API-equivalent cost.

## Approach

### 1. Store API-equivalent cost for zero-cost proxy/model-proxy sessions

1. In `packages/stats/src/db.ts`, extend the existing catalog fallback instead of adding a second cost pipeline:
   - Add a top-level value import from `@oh-my-pi/pi-catalog/identity`:
     `import { getBundledModelReferenceIndex, resolveModelReference } from "@oh-my-pi/pi-catalog/identity";`
   - Keep the existing `ModelCost`, `UsageCost`, `CostTokens`, `hasBillableCost`, `calculateCatalogCost`, `resolveStoredCost`, and `backfillMissingCatalogCosts` flow. Do not introduce runtime OpenRouter/CLIProxyAPI pricing fetches; this change is deterministic and catalog-backed.
   - Replace only `getCatalogCost(provider: string, modelId: string): ModelCost | null` with this precedence:
     1. `getBundledModelCost(provider, modelId)` when it exists and `hasBillableCost(...)` is true.
     2. If `provider === "openai-codex"`, `getBundledModelCost("openai", modelId)` when billable, preserving the current OpenAI Codex behavior.
     3. `const reference = resolveModelReference(modelId, getBundledModelReferenceIndex());` and return `reference.cost` only when `reference` exists and `hasBillableCost(reference.cost)` is true.
     4. Return `null`.
   - Preserve `resolveStoredCost(stats)` exactly for nonzero recorded totals: `if (stats.usage.cost.total !== 0) return stats.usage.cost;`. Provider-reported nonzero cost remains authoritative even if the catalog has a different price.
   - Preserve `backfillMissingCatalogCosts(database)` selection (`WHERE cost_total = 0 AND total_tokens > 0`) so old zero-cost rows are repaired on `initDb()` without rewriting rows that already have cost.
   - Failure/edge handling: unresolved references, references with all-zero `input/output/cacheRead/cacheWrite`, rows with zero total tokens, and direct zero-cost catalog entries remain zero. Do not fabricate GLM 5.2 pricing because the bundled `zai/glm-5.2` and `zhipu-coding-plan/glm-5.2` entries currently have zero cost.

2. In `packages/stats/test/db-cost.test.ts`, add proxy-cost coverage beside the existing OpenAI Codex tests:
   - Keep existing imports and add no mocks. Reuse `initDb()`, `closeDb()`, `insertMessageStats()`, `getRecentRequests()`, direct `Database`, and `getStatsDbPath()` patterns already in the file.
   - Add helper:
     ```ts
     function createProxyClaudeStats(entryId: string, cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }): MessageStats
     ```
     returning the same shape as `createCodexGptStats`, with `provider: "cliproxy-openai"`, `model: "vendor/claude-opus-4-8"`, `api: "anthropic-messages"`, `input: 1000`, `output: 500`, `cacheRead: 200`, `cacheWrite: 100`, `totalTokens: 1800`, and the supplied `cost`.
   - Add helper `expectedClaudeOpusCost()` using `const cost = getBundledModel("anthropic", "claude-opus-4-8").cost;` and returning `input`, `output`, `cacheRead`, `cacheWrite`, and `total` calculated as `(cost.<field> / 1_000_000) * tokens`. The expected values are derived from the bundled Anthropic Opus 4.8 cost, not hard-coded literals.
   - Add test `stores API-equivalent cost when proxy Claude usage has zero cost`: `await initDb()`, insert `createProxyClaudeStats("proxy-inserted")`, then assert the newest request has each cost field close to `expectedClaudeOpusCost()` with precision 8 and `expected.total > 0`.
   - Add test `backfills existing zero-cost proxy Claude rows on database init`: create DB once, `closeDb()`, insert a raw `messages` row with the same provider/model/tokens and all cost columns zero, close, `await initDb()`, then assert `getRecentRequests(1)[0]?.usage.cost.total` is close to `expectedClaudeOpusCost().total`.
   - Add test `preserves provider-reported nonzero proxy cost`: insert `createProxyClaudeStats("proxy-reported", { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 })` and assert the stored total is `0.1` and not close to `expectedClaudeOpusCost().total` when the values differ. This locks the nonzero-cost precedence.

### 2. Sync stats automatically during harness launch and shutdown

1. In `packages/coding-agent/src/main.ts`, add a top-level value import because inline imports are forbidden in this repo:
   `import { syncAllSessions } from "@oh-my-pi/omp-stats";`

2. Extend `RunRootCommandDependencies` with internal seams for tests and no production callsite changes:
   ```ts
   syncStatsSessions?: typeof syncAllSessions;
   registerPostmortem?: typeof postmortem.register;
   enableStatsAutoSync?: boolean;
   ```
   Production callers in `packages/coding-agent/src/commands/acp.ts`, `packages/coding-agent/src/commands/join.ts`, and `packages/coding-agent/src/commands/launch.ts` keep calling `runRootCommand(parsed, args)` or `runRootCommand(parsed, [])` unchanged. Existing tests that call `runRootCommand` but do not assert stats syncing must pass `enableStatsAutoSync: false`; the current search result shows those dependency objects are in `packages/coding-agent/test/acp-lazy-startup.test.ts`.

3. Add module-level guarded helper near `RunRootCommandDependencies`:
   ```ts
   let statsAutoSyncRegistered = false;
   let statsAutoSyncPromise: Promise<void> | null = null;

   function registerStatsAutoSync(
     syncStatsSessions: typeof syncAllSessions = syncAllSessions,
     registerPostmortem: typeof postmortem.register = postmortem.register,
   ): void
   ```
   Exact behavior:
   - If `statsAutoSyncRegistered` is true, return immediately.
   - Set `statsAutoSyncRegistered = true`.
   - Define inner `runStatsSync(reason: "startup" | "shutdown", workers?: number): Promise<void>` that returns the existing `statsAutoSyncPromise` if non-null; otherwise sets it to an async call to `syncStatsSessions(workers === undefined ? undefined : { workers })`, catches errors, logs failures with `logger.debug("Stats auto-sync failed", { reason, err })`, and clears `statsAutoSyncPromise` in `finally`.
   - Start startup sync as fire-and-forget: `void runStatsSync("startup");` Do not await it and do not write to stdout/stderr.
   - Register shutdown sync with `registerPostmortem("stats-sync", () => runStatsSync("shutdown", 1));` so shutdown uses one worker and does not contend with process exit. Do not call the returned unregister function in production.
   - Do not add a user-facing env flag, config setting, CLI output, retry loop, or timer.

4. In `runRootCommand`, call the helper only when `deps.enableStatsAutoSync !== false`:
   ```ts
   if (deps.enableStatsAutoSync !== false) {
     registerStatsAutoSync(deps.syncStatsSessions ?? syncAllSessions, deps.registerPostmortem ?? postmortem.register);
   }
   ```
   Place this immediately after the `if (parsedArgs.resume === true && !parsedArgs.fork) { ... }` resume-picker block and before `await pluginPreloadPromise;`. The call must happen for the explicit harness launch command `env -u PI_CODING_AGENT_DIR bun /home/ceeb/orca/workspaces/oh-my-pi/main/packages/coding-agent/src/cli.ts` and for print/protocol modes that reach normal root-command startup; it must not run for early exits that return or `process.exit` before a runnable session is selected (version/export/bad args/resume cancelled/no session selected).

5. Add `packages/coding-agent/test/stats-auto-sync.test.ts` using the existing `runRootCommand` dependency-injection pattern from `packages/coding-agent/test/acp-lazy-startup.test.ts`:
   - Use `TempDir`, `AuthStorage.create(path.join(cwd, "auth.db"))`, `Settings.isolated({ "marketplace.autoUpdate": "off" })`, and a stub `runAcpMode` that throws a sentinel error after startup.
   - Pass `syncStatsSessions: async opts => { calls.push(opts); return { processed: 0, files: 0 }; }` and `registerPostmortem: (_id, callback) => { shutdownCallbacks.push(callback); return () => {}; }`. Do not call `postmortem.cleanup()` in this test; it permanently advances the module's cleanup state.
   - Single test flow: run `runRootCommand` in `mode: "acp"` with minimal parsed args (`messages: []`, `fileArgs: []`, `unknownFlags: new Map()`, `unrecognizedFlags: []`, `noSkills/noRules/noTools/noLsp/noExtensions: true`, `sessionDir: cwd`), swallow the sentinel, wait for the startup sync seam to resolve, assert `calls[0]` is `undefined`, call the captured shutdown callback, and assert the next call is `{ workers: 1 }`.
   - Guard flow in the same test file: call `runRootCommand` a second time with the same fake `registerPostmortem` and sync seam, swallow the sentinel, and assert `shutdownCallbacks.length` remains `1`. Also track an `inFlight` counter inside the seam and assert its maximum is `1`, proving startup/shutdown reuse the same promise when one sync is already running.
   - Ensure each test closes `authStorage` in `finally`. Existing `packages/coding-agent/test/acp-lazy-startup.test.ts` runRootCommand tests must pass `enableStatsAutoSync: false` so they do not mutate the auto-sync guard or run real stats scans.

### 3. Make dashboard sync/update automatic without adding SSE or WebSockets

1. In `packages/stats/src/server.ts`, keep read endpoints DB-only but guard expensive syncs:
   - Add module-level:
     ```ts
     let syncInFlight: Promise<{ processed: number; files: number }> | null = null;
     async function runServerSync(): Promise<{ processed: number; files: number }>
     ```
   - `runServerSync()` returns `syncInFlight` when non-null; otherwise sets it to `syncAllSessions().finally(() => { syncInFlight = null; })` and returns it.
   - Change `/api/sync` to `const result = await runServerSync(); const count = await getTotalMessageCount(); return Response.json({ ...result, totalMessages: count });`.
   - Failure handling: if `syncAllSessions()` rejects, clear `syncInFlight` in `finally` and let the HTTP handler return the existing non-OK behavior through the server error path; do not cache failures.

2. In `packages/stats/src/client/api.ts`, replace the current `sync(): Promise<any>` with an explicit response type:
   ```ts
   export interface SyncResult { processed: number; files: number; totalMessages: number }
   export async function sync(): Promise<SyncResult>
   ```
   Keep the endpoint `/api/sync` and the existing `if (!res.ok) throw new Error("Failed to sync");` behavior.

3. In `packages/stats/src/client/App.tsx`, merge manual sync, auto-sync, and data reloads into one sync-guarded refresh path:
   - Import `useRef` in addition to existing React hooks.
   - Add state:
     ```ts
     const [syncing, setSyncing] = useState(false);
     const [loadError, setLoadError] = useState<string | null>(null);
     const syncInFlight = useRef<Promise<void> | null>(null);
     ```
     Reuse the existing `syncing` state rather than adding a second visible spinner.
   - Change `loadRecentLists` and `loadActiveTabStats` so they throw errors instead of swallowing with `console.error`. Delete `console.error` calls from this file.
   - Add `const runSync = useCallback(async () => { ... }, []);` with exact behavior: if `syncInFlight.current` exists, return it; otherwise set `syncing` true, set `syncInFlight.current` to `sync().then(() => undefined).finally(() => { syncInFlight.current = null; setSyncing(false); })`, and return that promise.
   - Add `const refreshStats = useCallback(async ({ runSync: shouldSync }: { runSync: boolean }) => { ... }, [loadActiveTabStats, loadRecentLists, runSync]);` with exact behavior: clear `loadError`, await `runSync()` when `shouldSync` is true, then await `Promise.all([loadActiveTabStats(), loadRecentLists()])`; catch unknown errors into `setLoadError(error instanceof Error ? error.message : "Failed to refresh stats")` and leave existing data mounted.
   - `handleSync` becomes `() => void refreshStats({ runSync: true });`.
   - Replace the two existing 30-second effects with one effect that calls `void refreshStats({ runSync: true })` immediately and on a 30-second interval. This is the dashboard auto-update contract: every poll first syncs sessions, then refreshes active stats and recent lists. Because only sync is guarded, a tab/time-range change during an in-flight sync can still schedule a fresh data load after the shared sync promise resolves.
   - Add a small inline error banner above the active tab content when `loadError` is non-null. Copy: heading `Stats refresh failed`, body is the error message, button label `Retry`, and Retry calls `refreshStats({ runSync: true })`.
   - Failure handling: failed sync/read leaves existing data visible, shows the banner, and future intervals keep retrying. Manual Sync uses the same sync guard, so it cannot overlap with auto-sync.

### 4. Redesign the stats dashboard using the existing React/Tailwind stack

1. Do not add frontend dependencies or new assets. `packages/stats/package.json` already has React, Tailwind v4, Chart.js, date-fns, and `lucide-react`; continue using lucide and standardize stroke width to `1.5`. This intentionally follows the local redesign skill's “work with the existing stack” rule over its generic preference for other icon libraries.

2. In `packages/stats/src/client/styles.css`, replace the current multi-accent AI-gradient treatment with one restrained accent and semantic colors:
   - Light tokens: `--bg-page: #f6f5f2`, `--bg-surface: #ffffff`, `--bg-elevated: #efede8`, `--bg-hover: rgba(38, 35, 30, 0.05)`, `--bg-active: rgba(38, 35, 30, 0.09)`, `--bg-overlay: rgba(20, 18, 15, 0.42)`, `--border-subtle: rgba(38, 35, 30, 0.10)`, `--border-default: rgba(38, 35, 30, 0.18)`, `--text-primary: #211f1a`, `--text-secondary: #514d45`, `--text-muted: #7a7468`, `--accent-primary: #2f6f68`, `--accent-green: #2f7d4f`, `--accent-amber: #9a6a18`, `--accent-red: #b0443e`.
   - Dark tokens: `--bg-page: #11100e`, `--bg-surface: #191714`, `--bg-elevated: #23201c`, `--bg-hover: rgba(246, 245, 242, 0.05)`, `--bg-active: rgba(246, 245, 242, 0.09)`, `--bg-overlay: rgba(0, 0, 0, 0.56)`, `--border-subtle: rgba(246, 245, 242, 0.10)`, `--border-default: rgba(246, 245, 242, 0.18)`, `--text-primary: #f4f1ea`, `--text-secondary: #c9c2b4`, `--text-muted: #958d7f`, `--accent-primary: #78b8ae`, `--accent-green: #7cc693`, `--accent-amber: #d6aa55`, `--accent-red: #e17b72`.
   - Delete `--accent-pink`, `--accent-pink-glow`, `--accent-cyan`, `--accent-cyan-glow`, `--accent-violet`, `.gradient-text`, `.gradient-border`, `.glow-pink`, and `.glow-cyan`. Replace every usage before deleting.
   - Add `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, `--z-sticky: 10`, `--z-overlay: 40`, `--z-modal: 50`.
   - Change body font stack to `"SF Pro Display", "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`, remove `Roboto`, `Helvetica Neue`, and `Arial`, and change `min-height: 100vh` to `min-height: 100dvh`.
   - Add reusable classes: `.skip-link`, `.skeleton`, `.metric-number { font-variant-numeric: tabular-nums; }`, `.inline-error`, and focus-visible rules for `.btn`, `.tab-btn`, `.table-row-button`, and close buttons.
   - Change transitions from `all 0.15s ease` to property-specific transitions with `var(--ease-out)`; use `transform` and opacity only for motion where possible.

3. In `packages/stats/src/client/components/Header.tsx`, make navigation clearer and less decorative:
   - Keep `Activity` and `RefreshCw`; set both to `strokeWidth={1.5}`.
   - Replace the gradient logo tile with `className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-default)] flex items-center justify-center"` and color the icon with `text-[var(--accent-primary)]`.
   - Change title to `AI usage` and subtitle to `Usage, cost, and session health`.
   - Wrap the tab group in `<nav aria-label="Dashboard sections">`.
   - On active tab buttons add `aria-current="page"`; inactive buttons omit it.
   - Keep the time range group as buttons but add `aria-label="Time range"` on its wrapper.
   - Button text remains `Sync`/`Syncing...`, but the refresh icon uses the existing `.spin` only while syncing.

4. In `packages/stats/src/client/components/StatsGrid.tsx`, make metrics scannable and precise:
   - Add local `formatCost(value: number): string` with the same thresholds used in `CostSummary`: `< 0.01` uses 4 decimals, `< 1` uses 3 decimals, otherwise 2 decimals.
   - Rename labels exactly to sentence case: `Total requests`, `API-equivalent cost`, `Premium reqs`, `Cache rate`, `Input tokens`, `Output tokens`, `Error rate`, `Tokens/sec`, `TTFT`.
   - Change `Total Cost` detail to `API-equivalent from stored usage` and use `formatCost(s.totalCost)` for value and `formatCost(s.totalCost / s.totalRequests)` for avg/req.
   - Remove `color` from `statConfig`, remove inline `style`, and render all non-error/non-success icons with `text-[var(--accent-primary)]` on `bg-[var(--bg-elevated)]`.
   - Use semantic icon color only for `Error rate` (`--accent-red`) and success/premium only where meaning requires it; do not reintroduce rainbow cards.
   - Change the grid from `grid-cols-2 lg:grid-cols-3 xl:grid-cols-9` to an asymmetric bento layout: container `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4 mb-8`; first two cards (`Total requests`, `API-equivalent cost`) get `xl:col-span-2`, remaining cards get `xl:col-span-1`. Mobile remains one column.
   - Add `metric-number` to numeric values and `strokeWidth={1.5}` to all icons.

5. In `packages/stats/src/client/components/CostSummary.tsx`, fix small-cost presentation:
   - Replace `Math.round(value)` with:
     ```ts
     function formatCost(value: number): string {
       if (value < 0.01) return `$${value.toFixed(4)}`;
       if (value < 1) return `$${value.toFixed(3)}`;
       return `$${value.toFixed(2)}`;
     }
     ```
   - Rename cards to `API-equivalent total`, `Average per day`, and `Top model`; keep `Top model` subtext as the formatted model cost.
   - Add `metric-number` to rendered dollar values.

6. In `packages/stats/src/client/App.tsx`, add visible states while preserving existing tabs:
   - Wrap content in `<main id="stats-main">` and add an `<a href="#stats-main" className="skip-link">Skip to stats content</a>` before the main container.
   - Change outer `min-h-screen` to `min-h-[100dvh]`; change request/error tab heights from `h-[calc(100vh-140px)]` to `h-[calc(100dvh-140px)]`.
   - Replace the spinner `LoadingState` with `DashboardSkeleton({ kind }: { kind: "overview" | "table" | "charts" })` using `.skeleton` rectangles that match the visible layout. `overview` renders the same bento grid as `StatsGrid` with nine skeleton cards and the first two cards `xl:col-span-2`; each card has a 14px title line, 32px value block, and 12px detail line. `table` renders one surface with a header row and eight body rows. `charts` renders three summary-card skeletons followed by two 260px chart/table panels.
   - Keep loaded data mounted when refresh fails; only show skeletons when the relevant data is still null and no loaded data exists.

7. In `packages/stats/src/client/components/RequestList.tsx`, improve empty and keyboard states:
   - Add a composed empty state row using an existing lucide icon such as `Inbox` with `strokeWidth={1.5}`.
   - Empty copy must be exactly: heading `No requests in this range yet` and hint `Try a wider time range or sync now.`
   - Make clickable rows keyboard-operable by adding `tabIndex={0}`, `role="button"`, class `table-row-button`, and `onKeyDown` that calls `onSelect(req)` for `Enter` or space. Keep table semantics otherwise.
   - Add `metric-number` to token, cost, and duration cells. Keep cost as `$${req.usage.cost.total.toFixed(4)}` so request rows continue showing sub-cent values.

8. In `packages/stats/src/client/components/RequestDetail.tsx`, harden modal accessibility and remove gradients:
   - Track request detail load errors with state and show an inline error panel with a Retry button instead of `.catch(console.error)`. Delete the `console.error` call.
   - Add Escape-to-close in an effect and restore focus to `document.activeElement` captured before opening. Use `useRef` for the dialog panel and focus it on open with `tabIndex={-1}`.
   - Add `aria-labelledby="request-detail-title"` to the dialog and `id="request-detail-title"` to the heading.
   - Add `aria-label="Close request details"` to the close button.
   - Replace `z-[100]` with inline styles using the CSS z-index variables: backdrop wrapper `style={{ zIndex: "var(--z-overlay)" }}` and dialog panel/header layering `style={{ zIndex: "var(--z-modal)" }}` only where needed.
   - Replace gradient icon backgrounds and `gradient-text` throughput with solid `text-[var(--accent-primary)]` and neutral surfaces.
   - Change visible labels to sentence case except abbreviations that are standard metrics: `Request details`, `Premium reqs`, `Tokens`, `Duration`, `TTFT`, `Throughput`, `Output`, `Raw metadata`.

9. In `packages/stats/src/client/components/chart-shared.tsx` and `packages/stats/src/client/components/models-table-shared.tsx`, remove rainbow styling that conflicts with the new palette:
   - Replace `MODEL_COLORS` with this exact sequence: `#2f6f68`, `#5f817c`, `#7a7468`, `#8a7a5e`, `#4f6762`, `#2f7d4f`, `#9a6a18`, `#b0443e`. These fixed hexes match the new palette and avoid relying on CSS variables inside Chart.js dataset config.
   - Keep table column structure and existing data calculations unchanged.
   - Do not change API response shapes or chart semantics.

### 5. Final cleanup once behavior is verified

1. Update `packages/stats/CHANGELOG.md` under `## [Unreleased]`:
   - Add `### Changed` if missing with `- Redesigned the stats dashboard for clearer API-equivalent cost, loading, empty, error, and keyboard states.`
   - Add `### Fixed` if missing with `- Fixed zero-cost proxy/model-proxy stats rows to use bundled API-equivalent pricing when the model id resolves to a paid upstream catalog entry.`

2. Update `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`:
   - Under `### Added`, add `- Added background stats syncing on harness startup and shutdown so the stats dashboard can ingest new sessions without a manual sync.`

3. Do not edit `packages/catalog/src/models.json`. If implementation discovers a missing paid upstream catalog price that is required for the proxy model being tested, update the catalog generator/source/policy first and regenerate; for GLM 5.2 specifically, leave cost zero until a source-backed price exists.

## Critical files & anchors

- `packages/stats/src/db.ts` — `getCatalogCost`, `resolveStoredCost`, and `backfillMissingCatalogCosts`; this is where zero-cost rows become API-equivalent catalog cost while nonzero recorded cost remains authoritative.
- `packages/stats/test/db-cost.test.ts` — existing isolated SQLite tests for insert-time and init-time catalog cost correction; extend this file for proxy Claude insert/backfill/nonzero precedence.
- `packages/coding-agent/src/main.ts` — `RunRootCommandDependencies` and `runRootCommand`; this is the launch chokepoint for the explicit Bun harness command and the right place to register startup/shutdown stats sync.
- `packages/stats/src/client/App.tsx` — current dashboard polling and manual sync state; replace the two DB-only intervals with one guarded sync-then-refresh loop and visible load errors.
- `packages/stats/src/client/styles.css` — global dashboard tokens and component utilities; replace the current pink/cyan/violet gradient/glow system with the single-accent palette and shared accessibility states.

## Verification

1. Cost behavior, from repo root:
   - Run `bun --cwd=packages/stats test db-cost.test.ts`.
   - Expected: existing OpenAI Codex tests still pass; new proxy Claude insert/backfill tests pass; stored `vendor/claude-opus-4-8` cost equals the bundled `anthropic/claude-opus-4-8` API-equivalent calculation; nonzero provider-reported proxy cost remains unchanged.

2. Stats package type/style/build checks, from repo root:
   - Run `bun --cwd=packages/stats run check`.
   - Run `bun --cwd=packages/stats run build`.
   - Expected: no Biome/type errors; client build succeeds after Tailwind/CSS/React changes.

3. Harness auto-sync test, from repo root:
   - Run `bun --cwd=packages/coding-agent test stats-auto-sync.test.ts`.
   - Expected: `runRootCommand` registers one guarded startup/shutdown stats sync path, startup sync does not block protocol startup, shutdown sync calls the seam with `{ workers: 1 }`, and no stdout/stderr assertions fail.

4. Coding-agent package check, from repo root:
   - Run `bun --cwd=packages/coding-agent run check`.
   - Expected: no Biome/type errors after the new `syncStatsSessions` dependency seam and top-level `@oh-my-pi/omp-stats` import.

5. Manual end-to-end smoke, from repo root:
   - Launch the harness with `env -u PI_CODING_AGENT_DIR bun /home/ceeb/orca/workspaces/oh-my-pi/main/packages/coding-agent/src/cli.ts`.
   - In that harness, produce at least one assistant response using a CLIProxyAPI/model-proxy-backed model whose recorded session model id contains `claude-opus-4-8` (for example an alias shaped like `vendor/claude-opus-4-8`) and whose provider-reported usage cost is zero.
   - Open the stats dashboard with `bun /home/ceeb/orca/workspaces/oh-my-pi/main/packages/coding-agent/src/cli.ts stats --port 3847`, then visit `http://127.0.0.1:3847`.
   - Expected: within one 30-second polling interval, the dashboard ingests the new session without pressing Sync; the recent request row shows a nonzero sub-cent/cent API-equivalent cost instead of `$0`; the overview and costs tabs label the value as API-equivalent cost; loading states are skeletons; empty request lists show the composed empty state; request details close with Escape and restore focus.

## Assumptions & contingencies

- API-equivalent pricing is catalog-backed only. CLIProxyAPI exposes usage/model metadata but no pricing fields, and its usage queue is destructive and short-retention; do not integrate it for this change. If a model id cannot be resolved to a bundled paid reference, keep the stored cost zero and make no network pricing calls.
- The dashboard remains a polling UI. Use the guarded `/api/sync` poll because it fits the existing server and client; do not add SSE/WebSocket infrastructure unless a later request explicitly asks for push updates.
- The redesign must use the existing frontend dependencies. If an imported icon is unavailable in `lucide-react`, choose the closest existing lucide glyph and keep `strokeWidth={1.5}`; do not install another icon or motion package.
- `env -u PI_CODING_AGENT_DIR` needs no special path handling: stats DB location comes from the config-root data path. If implementation finds the harness command exits before `runRootCommand` reaches session-manager creation for a specific mode, keep early exits unsynced and place the auto-sync registration at the earliest post-session-manager point that all normal launch/print/protocol sessions share.
- Shutdown sync is best-effort. If startup sync is still running when shutdown begins, the guarded helper awaits the existing promise instead of starting a second scan; if sync fails, log with `logger.debug` and never print to the terminal.
