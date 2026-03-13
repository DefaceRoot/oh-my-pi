# Keyboard Shortcuts

This document provides the complete and detailed documentation for the 'Keyboard Shortcuts' section, found under the 'Usage' section of the `oh-my-pi` documentation. It includes navigation, editing, and other general shortcuts, as well as specific shortcuts for the Subagent Navigator.

## Keyboard Shortcuts

The `oh-my-pi` interactive terminal user interface provides a comprehensive set of keyboard shortcuts for efficient navigation, editing, and interaction with the AI coding agent . These shortcuts are displayed in a formatted table when you use the `/hotkeys` command . The `CommandController` handles the `handleHotkeysCommand()` function, which generates this markdown table dynamically .

### Navigation

| Key | Action |
|---|---|
| `Arrow keys` | Move cursor / browse history (Up when empty) |
| `Option+Left/Right` | Move by word |
| `Ctrl+A` / `Home` / `Cmd+Left` | Start of line |
| `Ctrl+E` / `End` / `Cmd+Right` | End of line |


### Editing

| Key | Action |
|---|---|
| `Enter` | Send message |
| `Shift+Enter` / `Alt+Enter` | New line |
| `Ctrl+W` / `Option+Backspace` | Delete word backwards |
| `Ctrl+U` | Delete to start of line |
| `Ctrl+K` | Delete to end of line |


### Other

| Key | Action |
|---|---|
| `Tab` | Path completion / accept autocomplete |
| `Escape` | Cancel autocomplete / abort streaming |
| `Ctrl+C` | Clear editor (first) / exit (second) |
| `Ctrl+D` | Exit (when editor is empty) |
| `Ctrl+Z` | Suspend to background (use `fg` in shell to resume) |
| `Shift+Tab` | Cycle thinking level |
| `Ctrl+P` | Cycle role models (orchestrator/default/explore) |
| `Shift+Ctrl+P` | Cycle role models temporarily (orchestrator/default/explore) |
| `Alt+P` | Select model (temporary) |
| `Ctrl+L` | Select model (set roles) |
| `Alt+A` | Cycle agent mode (Default/Orchestrator/Plan/Ask) |
| `Alt+Shift+P` | Toggle plan mode |
| `Ctrl+R` | Search prompt history |
| `Ctrl+O` | Toggle tool output expansion |
| `Ctrl+T` | Toggle todo list expansion |
| `Ctrl+G` | Open Lazygit |
| `Ctrl+G` | Edit message in external editor |
| `Alt+H` | Toggle speech-to-text recording |
| `/` | Slash commands |
| `!` | Run bash command |
| `!!` | Run bash command (excluded from context) |
| `$` | Run Python in shared kernel |
| `$$` | Run Python (excluded from context) |


Many of these keybindings are configurable through the `KeybindingsConfig` type . The `InputController` sets up custom key handlers for actions like opening Lazygit or an external editor . The `CustomEditor` component also defines callbacks for specific key combinations like `Ctrl+C`, `Ctrl+D`, `Ctrl+Z`, `Shift+Tab`, `Ctrl+P`, `Shift+Ctrl+P`, `Alt+P`, `Ctrl+L`, `Ctrl+R`, `Ctrl+T`, and `Ctrl+O`  .

### Subagent Navigator (Ctrl+X chord)

The Subagent Navigator uses a `Ctrl+X` chord for various actions related to subagents .

| Key | Action |
|---|---|
| `Ctrl+X` | Open subagent navigator (or close if already open) |
| `Ctrl+X, Ctrl+N` | Next subagent |
| `Ctrl+X, Ctrl+P` | Previous subagent |
| `Ctrl+X, Ctrl+O` | View most recently updated subagent |
| `Ctrl+X, Ctrl+R` | Refresh subagent list |
| `Ctrl+X, Ctrl+V` | Open navigator (explicit) |


## Notes

The provided context includes information about keyboard shortcuts in `agent/scripts/agents_view/app.py`  and `agent/scripts/agents_view/features/help_screen_v2.py` . However, these files appear to be related to an "Agents View" application, which is distinct from the `oh-my-pi` interactive mode described in the prompt. Therefore, these were not included in the detailed documentation for the `oh-my-pi` keyboard shortcuts.

Wiki pages you might want to explore:
- [Overview (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#1)
- [User Interface (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#5)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_2c624bdb-e1d1-495e-9128-c552be9d2a13

