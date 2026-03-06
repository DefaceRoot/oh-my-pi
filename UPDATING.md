# Updating This OMP Fork

This fork uses the repository itself as the source of truth for both product code and agent customizations.

- CLI source: `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/packages/coding-agent`
- Agent config source: `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent`
- Live runtime path: `~/.omp/agent -> /home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent`

Do not edit files under Bun's global install. Reinstall from the fork instead.

## Supported Update Loop

From `/home/colin/devpod-repos/DefaceRoot/oh-my-pi`:

```bash
git fetch upstream && git rebase upstream/main
bun install
bun run reinstall:fork
command -v omp && bun pm bin -g
```

If you want the exact non-interactive command from any working directory, use:

```bash
bun --cwd=/home/colin/devpod-repos/DefaceRoot/oh-my-pi run reinstall:fork
```

`bun run reinstall:fork` packs the local workspace packages into tarballs and installs those tarballs globally. That is what makes the live `omp` binary pick up fork changes across `packages/utils`, `packages/natives`, `packages/ai`, `packages/agent`, `packages/tui`, `packages/stats`, and `packages/coding-agent`.

## Why This Uses a Packed Reinstall Script, Not `bun link`

`bun link` is a development-link workflow. This fork needs a reproducible CLI replacement path that upgrades the globally installed binary and its internal workspace packages together. Packing local tarballs and reinstalling them globally gives one explicit cutover path, avoids split-brain behavior between linked sources and the active binary, and does not depend on Bun resolving `workspace:*` dependencies from a bare local package path.

## Expected Machine State

After cutover:

- `command -v omp` resolves inside Bun's global bin directory, typically `/home/colin/.bun/bin/omp`
- `bun pm bin -g` prints the same parent directory used by the active `omp`
- `~/.local/bin/omp` and `~/.local/bin/dpi` are gone from the workflow
- `~/.omp/agent` is a symlink to `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent`
- No `bun --cwd=packages/coding-agent src/cli.ts` watcher is required for normal use

## Smoke Verification

Run these checks after reinstall:

```bash
command -v omp
bun pm bin -g
file -h /home/colin/.omp/agent
pgrep -af 'bun --cwd=packages/coding-agent src/cli.ts'
```

Interpretation:

- `command -v omp` should print `/home/colin/.bun/bin/omp`
- `file -h /home/colin/.omp/agent` should report a symlink to `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent`
- `pgrep -af 'bun --cwd=packages/coding-agent src/cli.ts'` should print nothing

Then launch `omp` and confirm the UI reflects fork-managed assets:

- model list comes from `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/models.yml`
- keybindings/help reflect `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/keybindings.json`

## Editing Workflow

- Product changes: edit files under `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/packages/`
- Agent customization changes: edit files under `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/`
- Reinstall the fork after changes that should affect the globally installed `omp` runtime
