# Updating This OMP Fork

This fork uses the repository itself as the source of truth for both product code and agent customizations.

Definitions:
- `<fork-root>` = the local clone of your custom OMP fork
- live agent config = `~/.omp/agent -> <fork-root>/agent`

Do not edit files under Bun's global install. Edit the fork and refresh from there.

## What Actually Updates the Live `omp`

Git commit and push do not update the live local omp install. They only save and sync repository history.

Use this rule:
- Changes under `<fork-root>/packages/` require `bun run reinstall:fork` plus an `omp` restart
- Changes under `<fork-root>/agent/` usually only require restarting `omp`
- If a change touches both areas, do both: reinstall, then restart

## Supported Update Loop

From `<fork-root>`:

```bash
git fetch upstream && git rebase upstream/main
bun install
bun run reinstall:fork
command -v omp && bun pm bin -g
```

From any working directory:

```bash
bun --cwd=<fork-root> run reinstall:fork
```

`bun run reinstall:fork` packs the local workspace packages into tarballs, reinstalls them globally, relinks internal workspace dependencies, and verifies that `omp` can start. Use that instead of `bun link`.

## Why This Uses a Packed Reinstall Script, Not `bun link`

`bun link` is a development-link workflow. This fork needs a reproducible CLI replacement path that upgrades the globally installed binary and its internal workspace packages together. Packing local tarballs and reinstalling them globally gives one explicit cutover path and avoids split-brain behavior between linked sources and the active binary.

## Expected Machine State

After refresh:
- `command -v omp` resolves inside Bun's global bin directory
- `bun pm bin -g` prints the parent directory of the active `omp`
- `~/.omp/agent` is a symlink to `<fork-root>/agent`
- no `bun --cwd=packages/coding-agent src/cli.ts` watcher is required for normal use

## Smoke Verification

Run these checks after reinstall:

```bash
command -v omp
bun pm bin -g
file -h ~/.omp/agent
pgrep -af 'bun --cwd=packages/coding-agent src/cli.ts'
```

Interpretation:
- `command -v omp` should print a path inside Bun's global bin directory
- `file -h ~/.omp/agent` should report a symlink to `<fork-root>/agent`
- `pgrep -af 'bun --cwd=packages/coding-agent src/cli.ts'` should print nothing

Then launch `omp` and confirm the UI reflects fork-managed assets:
- model list comes from `<fork-root>/agent/models.yml`
- keybindings/help reflect `<fork-root>/agent/keybindings.json`

## Editing Workflow

- Product changes: edit files under `<fork-root>/packages/`
- Agent customization changes: edit files under `<fork-root>/agent/`
- Pure agent-layer changes usually need only an `omp` restart
- Package/runtime changes need `bun run reinstall:fork` and an `omp` restart
