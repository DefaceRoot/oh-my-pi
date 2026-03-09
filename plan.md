We are going to refactor how buttons work:
1. `ACTION_BUTTONS` in `action-buttons.ts` currently is a flat list. We will modify it to support an `actionMenu` property or introduce an `ACTION_MENUS` list. But the prompt specifically asks to:
   - "group the worktree-related actions under a stable Worktree top-level button/menu"
   - "rename to clearer labels... [Create] Freeform and [Create] Planned"
   - "each top-level button can be opened by its dedicated hotkey, entering a submenu-navigation mode"
   - "inapplicable actions are still visible in a disabled state instead of being removed"

The `status-line.ts` currently looks for hook statuses to render. 
If we replace `ACTION_BUTTONS` with a dynamic approach, maybe we can render the new menu inline in the status-line hook area.
Wait, `implementation-engine` sets individual `setStatus(key, "...")`. We need to intercept this or change `implementation-engine` to only set the state (enabled/disabled). But changing `implementation-engine` is cleaner because the logic of what is enabled lives there.

Let's modify `implementation-engine/index.ts` to output a state struct or use specific text to denote disabled vs active, but wait, the prompt says "The current footer/button system appears string-based and may require introducing a more structured representation. Keep the design maintainable for future nested buttons beyond worktree. Disabled actions must still render in a visually distinct state without becoming keyboard-selectable."

What if we create a new UI API `ctx.ui.setActionButtonState(menuId: string, actionId: string, state: 'hidden'|'disabled'|'active')`? The implementation-engine can call that, or just `setButtonState(id, state)`. Since we're refactoring `action-buttons.ts`, we can move away from hook strings to a dedicated `ActionButtonController` or similar. But `status-line.ts` renders them.

Actually, if we look at `status-line.ts`:
```ts
		const showHooks = this.settings.showHookStatus ?? true;
		if (!showHooks || this.hookStatuses.size === 0) {
			return [];
		}

		const subagentStatus = this.hookStatuses.get(SUBAGENT_VIEWER_STATUS_KEY);
		if (subagentStatus) {
			return [truncateToWidth(sanitizeStatusText(subagentStatus), width)];
		}

		const sortedStatuses = Array.from(this.hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const hookLine = sortedStatuses.join(" ");
```
It renders hook statuses directly. If we introduce a `workflowMenu` property into the `StatusLineComponent`, it could render that *instead of* or *in addition to* the hook statuses.

Let's do this:
1. Define a structured menu model in `action-buttons.ts`:
```ts
export interface WorkflowAction {
	id: string;
	label: string;
	command: string;
	editorText?: string;
}

export interface WorkflowMenu {
	id: string;
	label: string;
	hotkeyAction: AppAction;
	actions: WorkflowAction[];
}
```

2. Expose the menus and active states to `InteractiveMode`. It will have a `workflowMenus` state:
- which menu is open?
- which item is selected?
- what is the state of each action (hidden/disabled/enabled)?

Wait, the prompt says "Give each top-level button its own dedicated hotkey that opens a focused submenu instead of immediately running a command."

So `status-line.ts` should render:
- Normally: `[ Worktree (Alt+W) ]  [ OtherMenu ]  Refresh OMP`
- When Worktree menu is open: `[ Worktree (Alt+W) ] >  [Create] Freeform  [Create] Planned  Git  ! Sync` 
where disabled ones are grayed out, and selected one is highlighted.

If `implementation-engine` sets the state of each action, it would be much cleaner. Let's look at what `implementation-engine` actually sets today. It sets strings that represent buttons.
If we change `implementation-engine` to call a new `pi.setMenuState` or we just map its current string-settings to action states.

The prompt says: "Introduce or extend a coherent button/menu data model rather than piling more flat status strings onto the footer." This implies we should change `implementation-engine/index.ts` to use a better data model to control the buttons, or the host maintains the buttons and the engine just enables/disables them.

Let's check `InteractiveMode.ts` - how does it receive information? Via `this.extensionUiController`. `implementation-engine` receives `ctx.ui` which is an `ExtensionUIContext`. We can add `setWorkflowActionState(actionId: string, state: 'hidden' | 'disabled' | 'enabled')` to `ExtensionUIContext`.

Let's look at `ExtensionUIContext` in `packages/coding-agent/src/extensibility/extensions/types.ts`:
```ts
	/** Set status text in the footer/status bar. Pass undefined to clear. */
	setStatus(key: string, text: string | undefined): void;
```
We can add:
```ts
	/** Set the state of a workflow action. */
	setWorkflowActionState(actionId: string, state: "hidden" | "disabled" | "enabled"): void;
```

Then in `implementation-engine/index.ts` we replace all the `setStatus` calls for the worktree actions with `setWorkflowActionState`.

Wait, the instructions say:
"Update the visibility logic so context-inapplicable actions remain visible but disabled instead of disappearing."
"Start by grouping the worktree-related actions under a stable Worktree top-level button/menu."

If we update `implementation-engine/index.ts`:
Instead of:
```ts
		if (!hasActiveWorktree) {
			ctx.ui.setStatus(PLAN_WORKFLOW_STATUS_KEY, FREEFORM_WORKTREE_ACTION_TEXT);
			ctx.ui.setStatus(IMPLEMENT_WORKFLOW_STATUS_KEY, PLANNED_WORKTREE_ACTION_TEXT);
            ...
```
It would do:
```ts
        ctx.ui.setWorkflowActionState("freeform-worktree", !hasActiveWorktree ? "enabled" : "disabled");
        ctx.ui.setWorkflowActionState("planned-worktree", !hasActiveWorktree ? "enabled" : "disabled");
        ctx.ui.setWorkflowActionState("review-complete", !hasActiveWorktree ? "enabled" : "disabled");
        // wait, review-complete is for submit-pr.
```

Let's map out the actions in `implementation-engine/index.ts`:
- "freeform-worktree" -> `[Create] Freeform`
- "planned-worktree" -> `[Create] Planned`
- "git-menu" -> `Git`
- "sync-branch" -> `! Sync` (Wait, sync-branch is a specific action or just git-menu with sync status? The code sets `SYNC_NEEDED_STATUS_KEY` to `! Sync` which maps to `/git-menu`.)
- "submit-pr" -> `Submit PR`
- "review-complete" -> `Review`
- "fix-issues" -> `Fix Issues`
- "update-version-workflow" -> `Update Version`
- "delete-worktree" -> `✕ Worktree`
- "cleanup-worktrees" -> `Cleanup`
- "plan-review" -> `Plan Review`
- "fix-plan" -> `Fix Plan`

If we group worktree-related actions:
- `Worktree` Top-Level Menu
  - `[Create] Freeform`
  - `[Create] Planned`
  - `Plan Review`
  - `Fix Plan`
  - `Git` (or `! Sync`)
  - `Submit PR`
  - `Review`
  - `Fix Issues`
  - `Update Version`
  - `Cleanup`
  - `✕ Worktree`

All of these can be in the `Worktree` menu!
Let's modify `action-buttons.ts`:
```ts
export interface WorkflowAction {
	id: string;
	label: string;
	command: string;
	editorText?: string;
}

export interface WorkflowMenu {
	id: string;
	label: string;
	hotkeyAction: AppAction;
	actions: WorkflowAction[];
}

export const WORKFLOW_MENUS: WorkflowMenu[] = [
	{
		id: "worktree",
		label: "Worktree",
		hotkeyAction: "toggleWorktreeMenu", // new AppAction
		actions: [
			{ id: "freeform-worktree", label: "[Create] Freeform", command: "/freeform-worktree" },
			{ id: "planned-worktree", label: "[Create] Planned", command: "/planned-worktree" },
			{ id: "plan-review", label: "Plan Review", command: "/plan-review", editorText: "..." },
			{ id: "fix-plan", label: "Fix Plan", command: "/fix-plan", editorText: "..." },
			{ id: "git-menu", label: "Git", command: "/git-menu" },
			{ id: "sync-branch", label: "! Sync", command: "/git-menu" },
			{ id: "submit-pr", label: "Submit PR", command: "/submit-pr" },
			{ id: "review-complete", label: "Review", command: "/review-complete" },
			{ id: "fix-issues", label: "Fix Issues", command: "/fix-issues" },
			{ id: "update-version-workflow", label: "Update Version", command: "/update-version-workflow" },
			{ id: "cleanup-worktrees", label: "Cleanup", command: "/cleanup-worktrees" },
			{ id: "delete-worktree", label: "✕ Worktree", command: "/delete-worktree" },
		],
	},
];
```

We need to add `toggleWorktreeMenu` to `AppAction` in `packages/coding-agent/src/config/keybindings.ts`.
Default binding: maybe `alt+w` or something. Let's see what keys are free.

In `ExtensionUIContext` (`packages/coding-agent/src/extensibility/extensions/types.ts`):
```ts
	setWorkflowActionState(actionId: string, state: "hidden" | "disabled" | "enabled"): void;
```

In `ExtensionUIController` (`packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`):
```ts
	setWorkflowActionState(actionId: string, state: "hidden" | "disabled" | "enabled"): void {
		this.ctx.statusLine.setWorkflowActionState(actionId, state);
		this.ctx.ui.requestRender();
	}
```

In `StatusLineComponent` (`packages/coding-agent/src/modes/components/status-line.ts`):
Track `workflowActionStates: Map<string, "hidden" | "disabled" | "enabled">`.
Track `activeMenuId: string | undefined`.
Track `activeMenuSelectedIndex: number`.

In `InputController` (`packages/coding-agent/src/modes/controllers/input-controller.ts`):
Map `toggleWorktreeMenu` -> `ctx.statusLine.toggleMenu("worktree")`

In `InteractiveMode`:
Needs to pass the keypresses to the menu if it's open.
Wait, `StatusLineComponent` is just a component. If it's focused, it receives input.
If we make `StatusLineComponent` focusable, or if we intercept in `InputController`:
```ts
		if (this.ctx.statusLine.isMenuOpen()) {
			if (matchesKey(data, "left")) ...
			if (matchesKey(data, "right")) ...
			if (matchesKey(data, "enter")) ...
			if (matchesKey(data, "escape")) ...
            return;
        }
```
Wait, `StatusLineComponent` doesn't receive input directly unless it is focused. The `InputController` is where we wire up keys for the `InteractiveMode`. It intercepts inputs. We can add a handler in `InteractiveMode` or `InputController`.
```ts
		const toggleWorktreeKeys = this.ctx.keybindings.getKeys("toggleWorktreeMenu");
		for (const key of toggleWorktreeKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.ctx.toggleWorkflowMenu("worktree");
			});
		}
```
If menu is open, `editor.setCustomKeyHandler("left")` would override the editor navigation. We probably want `InteractiveMode` to intercept before `editor`? Actually, `editor.setCustomKeyHandler` is evaluated first in `CustomEditor.handleInput`. So we can dynamically add/remove handlers, or just do it in `CustomEditor`. But `CustomEditor` is part of `InteractiveMode`.
Better to handle menu input inside `InputController` or `InteractiveMode.handleInput`? Wait, `InteractiveMode` doesn't have `handleInput`. `TUI` forwards to `focusedComponent` which is `editor`.

So we can do:
```ts
		this.ctx.editor.setCustomKeyHandler("escape", () => {
			if (this.ctx.activeWorkflowMenu) {
				this.ctx.activeWorkflowMenu = undefined;
				this.ctx.ui.requestRender();
				return true; // handled
			}
			return false; // let normal escape happen
		});
```
Actually, `CustomEditor` has `onEscape`. We can just handle it there.

Wait, if we use `StatusLineComponent` for this, we have to render the menu.
Let's see how `StatusLineComponent` renders hook statuses.
```ts
		const showHooks = this.settings.showHookStatus ?? true;
		if (!showHooks) return [];

		if (this.activeMenuId) {
			// render menu
            const menu = WORKFLOW_MENUS.find(m => m.id === this.activeMenuId);
            // build string with highlighted active item
            return [truncateToWidth(menuString, width)];
        }
```

Then we need to pass mouse events to it as well in `InteractiveMode.handleFooterMouseClick`.
