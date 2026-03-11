# Updating This OMP Fork

This fork uses a direct launcher that runs `omp` straight from the repository source. No global package reinstall is needed for day-to-day use.

Definitions:
- `<fork-root>` = the local clone of your custom OMP fork
- live agent config = `~/.omp/agent -> <fork-root>/agent`

## What the Launcher Does

The `omp` command is a shell script at `<fork-root>/omp`. It runs:

```bash
PI_CODING_AGENT_DIR=<fork-root>/agent \
  bun <fork-root>/packages/coding-agent/src/cli.ts
```

Because the launcher does not pass `--cwd`, `omp` inherits the caller's current working directory for session runtime state. Changes to fork source still take effect on the next `omp` restart (next launch).

## What Updates Mean Now

- Changes under `<fork-root>/packages/` take effect on the next `omp` restart (no reinstall needed)
- Changes under `<fork-root>/agent/` take effect on the next `omp` restart
- The refresh button in the UI runs `bun install` to update dependencies, then restarts `omp`

## Upstream Sync

To bring in upstream changes:

```bash
cd <fork-root>
git fetch upstream && git rebase upstream/main
bun install
```

Then restart `omp` normally. The launcher runs the updated source immediately.

## Legacy Global Install

`bun run reinstall:fork` still exists for backward compatibility but is no longer the recommended workflow. It performs a full global package reinstall from packed tarballs. Use only if you specifically need the legacy global install behavior.

## Expected Machine State

After setup:

- `command -v omp` resolves to the fork launcher (via `~/.local/bin/omp` symlink or direct PATH entry)
- `~/.omp/agent` is a symlink to `<fork-root>/agent`

## Smoke Verification

Run these checks:

```bash
command -v omp
file -h ~/.omp/agent
ls -la <fork-root>/omp
```

Interpretation:

- `command -v omp` should print a path like `~/.local/bin/omp` or `<fork-root>/omp`
- `file -h ~/.omp/agent` should report a symlink to `<fork-root>/agent`
- The launcher script at `<fork-root>/omp` should exist and be executable

Then restart `omp` and confirm the UI reflects fork-managed assets:

- model list comes from `<fork-root>/agent/models.yml`
- keybindings/help reflect `<fork-root>/agent/keybindings.json`

## Editing Workflow

- Product changes: edit files under `<fork-root>/packages/`, then restart `omp`
- Agent customization changes: edit files under `<fork-root>/agent/`, then restart `omp`
- Dependency updates: run `bun install` in `<fork-root>`, then restart `omp`
