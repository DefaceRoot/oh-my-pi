# Editor Features

The user is asking for detailed documentation on the "Editor Features" section of the wiki, which is part of the "Usage" section. This information can be found in the `README.md` file  and further elaborated by the `Editor` component in `packages/tui/src/components/editor.ts`  and its associated tests .

## Editor Features

The editor component provides advanced input capabilities within the terminal user interface. 

### Core Features

*   **File reference (`@`)**: You can fuzzy-search project files by typing `@`. This feature respects `.gitignore` rules. 
*   **Path completion (Tab)**: The editor supports completing relative paths, `../`, and `~/` using the `Tab` key. 
*   **Drag & drop**: Files can be dragged directly from your file manager into the terminal. 
*   **Multi-line paste**: When pasting multi-line content, it is collapsed in the preview but sent in full. 
*   **Message queuing**: You can submit messages even while the agent is actively working. The behavior of this queue is configurable in `/settings`. 
*   **Multi-line editing with word wrap**: The editor handles multi-line input and automatically wraps words to fit the terminal width.  This includes intelligent wrapping at word boundaries and breaking long words (like URLs) at character level if necessary.  
*   **Slash command autocomplete**: Typing `/` triggers autocomplete for available slash commands. 
*   **File path autocomplete**: Pressing `Tab` provides file path autocompletion. 
*   **Large paste handling**: Pastes exceeding 10 lines are indicated with a `[paste #1 +50 lines]` marker. 
*   **Horizontal lines above/below editor**: The editor includes visual separators. 
*   **Fake cursor rendering**: A visual cursor is rendered, while the actual terminal cursor is hidden. 

### Editor Component Details

The `Editor` component, defined in `packages/tui/src/components/editor.ts` , manages the state and rendering of the multi-line text input.

#### State Management

The editor's internal state is managed by the `#state` property, which includes `lines`, `cursorLine`, and `cursorCol`. 

#### History Navigation

The editor maintains a history of prompts, allowing navigation using arrow keys. 
*   **Up arrow (`\x1b[A`)**: Navigates to older history entries. 
*   **Down arrow (`\x1b[B`)**: Navigates to newer history entries, eventually returning to an empty editor if at the newest entry. 
*   History entries are anchored at the top when navigating up and at the bottom when navigating down.  
*   Typing a character or calling `setText` exits history browsing mode.  
*   Empty strings and consecutive duplicate entries are not added to history.  
*   History is limited to 100 entries. 

#### Undo/Redo

The editor supports an undo stack for state changes, managed by `#undoStack`.  The `#applyUndo()` method reverts the editor to a previous state. 

#### Kill Ring

An Emacs-style kill ring (`#killRing`) is implemented for managing cut/copied text.  The `#recordKill()` method adds text to the kill ring. 

#### Autocomplete

The editor supports autocomplete functionality via an `AutocompleteProvider`.  Autocomplete updates are debounced. 

#### Rendering

The `render(width: number)` method is responsible for drawing the editor content, including borders and handling word wrapping.  It can also display custom content in the top border, such as a status line. 

### Key Bindings

The `Editor` component handles various key bindings for navigation and editing: 

#### Navigation
| Key | Action |
|---|---|
| Arrow keys | Move cursor / browse history (Up when editor is empty)  |
| Option+Left/Right | Move by word  |
| Ctrl+A / Home / Cmd+Left | Move to start of line  |
| Ctrl+E / End / Cmd+Right | Move to end of line  |

#### Editing
| Key | Action |
|---|---|
| Enter | Send message  |
| Shift+Enter / Alt+Enter | New line  |
| Ctrl+W / Option+Backspace | Delete word backwards  |
| Ctrl+U | Delete to start of line  |
| Ctrl+K | Delete to end of line  |
| Ctrl+- | Undo last edit  |

#### Other
| Key | Action |
|---|---|
| Tab | Path completion / accept autocomplete  |
| Escape | Cancel autocomplete / abort streaming  |
| Ctrl+C | Clear editor (first press) / exit (second press)  |
| Ctrl+D | Exit (when editor is empty)  |
| Ctrl+Z | Suspend to background (use `fg` in shell to resume)  |
| Shift+Tab | Cycle thinking level  |
| Ctrl+P / Shift+Ctrl+P | Cycle role models (orchestrator/default/explore), temporary on shift  |

## Notes

The prompt specifically asked for the "Editor Features" wiki page under the "Usage" section. The information provided is directly extracted from the `README.md` file  and supplemented with details from the `Editor` component's implementation  and its test suite . The `packages/tui/README.md` file also provides a summary of editor features and key bindings .

The "User Interface" wiki page  and "Execution Modes" wiki page  provide broader context on the TUI system and different operational modes, but the specific details for "Editor Features" are found in the cited `README.md` and `editor.ts` files. The `rpc-mode.ts` file  mentions an `editor` method for extension UI in RPC mode, but this is a programmatic interface for an editor dialog, not the interactive editor features described in the prompt.

Wiki pages you might want to explore:
- [Execution Modes (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#1.2)
- [User Interface (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#5)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_92dd4f27-9d2a-43fc-b344-292c30755ea3

