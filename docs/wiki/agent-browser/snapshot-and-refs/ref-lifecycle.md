# Ref Lifecycle

The user is asking for the complete documentation of the 'Ref Lifecycle' section from the `snapshot-refs.md` file. This section explains how references (`@refs`) are managed and invalidated within the `agent-browser` tool. 

## Ref Lifecycle

Refs are invalidated when the page changes.  This means that after any action that modifies the page content or navigates to a new page, you must re-snapshot to obtain valid references for the current state. 

### Example of Ref Invalidation 

```bash
# Get initial snapshot
agent-browser snapshot -i
# @e1 [button] "Next"

# Click triggers page change
agent-browser click @e1

# MUST re-snapshot to get new refs!
agent-browser snapshot -i
# @e1 [h1] "Page 2"  ← Different element now!
``` 

## Best Practices 

To ensure correct interaction with the browser, follow these best practices regarding ref lifecycle:

### 1. Always Snapshot Before Interacting 

Before using any `@ref` for interaction, you must first take a snapshot to generate the references. 

**Correct Usage:** 
```bash
agent-browser open https://example.com
agent-browser snapshot -i          # Get refs first
agent-browser click @e1            # Use ref
``` 

**Incorrect Usage:** 
```bash
agent-browser open https://example.com
agent-browser click @e1            # Ref doesn't exist yet!
``` 

### 2. Re-Snapshot After Navigation 

After an action that navigates to a new page, such as clicking a link or submitting a form, you must re-snapshot to get new, valid references for the new page.  This is also highlighted in `SKILL.md` as an important aspect of the Ref Lifecycle. 

```bash
agent-browser click @e5            # Navigates to new page
agent-browser snapshot -i          # Get new refs
agent-browser click @e1            # Use new refs
``` 

### 3. Re-Snapshot After Dynamic Changes 

If an action causes dynamic content changes on the current page (e.g., opening a dropdown, displaying a modal, or loading new content), you need to re-snapshot to capture the updated DOM and get references for the newly appeared elements. 

```bash
agent-browser click @e1            # Opens dropdown
agent-browser snapshot -i          # See dropdown items
agent-browser click @e7            # Select item
``` 

### 4. Snapshot Specific Regions 

For very complex pages, you can snapshot specific regions to reduce the output and focus on relevant elements. 

```bash
# Snapshot just the form
agent-browser snapshot @e9
``` 

## Troubleshooting 

### "Ref not found" Error 

If you encounter a "Ref not found" error, it likely means the ref has become stale due to a page change.  The solution is to re-snapshot the page. 

```bash
# Ref may have changed - re-snapshot
agent-browser snapshot -i
``` 

### Element Not Visible in Snapshot 

If an element you expect to see is not present in the snapshot, it might be off-screen.  You can scroll the page to make the element visible and then re-snapshot. 

```bash
# Scroll to reveal element
agent-browser scroll --bottom
agent-browser snapshot -i
``` 

## Notes

The `packages/coding-agent/src/modes/subagent-view/subagent-index.ts` file contains logic for managing `SubagentViewRef` objects, which are internal representations of references within the `coding-agent`.  This code handles the creation, merging, and sorting of these references into a snapshot.  While it deals with the internal lifecycle of these `SubagentViewRef` objects, it is distinct from the user-facing "Ref Lifecycle" described in `agent/skills/agent-browser/references/snapshot-refs.md`, which focuses on when a user of `agent-browser` needs to re-snapshot.  The `subagent-index.ts` file is more about how the agent itself maintains its internal state of references.  Similarly, the test files like `packages/coding-agent/test/subagent-sidebar-hotpath.test.ts` and `packages/coding-agent/test/subagent-viewer-hotpath.test.ts` define helper functions like `makeRef` and `makeSnapshot` to create mock `SubagentViewRef` and `SubagentIndexSnapshot` objects for testing purposes.   These are internal implementation details and testing utilities, not directly part of the user-facing "Ref Lifecycle" documentation. 

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_2f5a62b2-b8f5-4dcb-885f-4af35668ddf5

