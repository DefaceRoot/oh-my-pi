# How Refs Work

This document provides a detailed explanation of how "Refs" work within the `agent-browser` tool, based on the `snapshot-refs.md` documentation . Refs are compact element references designed to reduce context usage for AI agents when interacting with web pages .

## How Refs Work

The `agent-browser` approach to web interaction significantly reduces token usage compared to traditional methods .

*   **Traditional Approach**: Involves parsing the full DOM/HTML, then using CSS selectors for actions, which can consume 3000-5000 tokens .
*   **`agent-browser` Approach**: Utilizes a compact snapshot and assigns `@refs` for direct interaction, typically using only 200-400 tokens .

## The Snapshot Command

The `snapshot` command is used to generate these references .

*   **Basic Snapshot**: `agent-browser snapshot` shows the page structure .
*   **Interactive Snapshot (Recommended)**: `agent-browser snapshot -i` provides interactive elements .

### Snapshot Output Format

The output of the `snapshot` command displays the page title, URL, and a hierarchical list of interactive elements with their assigned `@refs` .

For example:
```
Page: Example Site - Home
URL: https://example.com

@e1 [header]
  @e2 [nav]
    @e3 [a] "Home"
    @e4 [a] "Products"
    @e5 [a] "About"
  @e6 [button] "Sign In"
``` 

## Using Refs

Once refs are obtained, they can be used for direct interaction with elements .

Examples:
*   Clicking a button: `agent-browser click @e6` 
*   Filling an input field: `agent-browser fill @e10 "user@example.com"` 
*   Submitting a form: `agent-browser click @e12` 

## Ref Lifecycle

Refs are invalidated when the page changes . After any action that modifies the page content or navigates to a new page, a new snapshot must be taken to get updated refs .

## Best Practices

### 1. Always Snapshot Before Interacting
Always take a snapshot to get refs before attempting to interact with elements .

### 2. Re-Snapshot After Navigation
After navigating to a new page, always re-snapshot to obtain new, valid refs .

### 3. Re-Snapshot After Dynamic Changes
If dynamic content changes the page (e.g., opening a dropdown), re-snapshot to see the new elements .

### 4. Snapshot Specific Regions
For complex pages, you can snapshot specific areas using a ref to narrow down the scope .

## Ref Notation Details

A ref notation provides details about the element it represents :
`@e1 [tag type="value"] "text content" placeholder="hint"`
*   `@e1`: Unique ref ID 
*   `[tag]`: HTML tag name 
*   `type="value"`: Key attributes shown 
*   `"text content"`: Visible text 
*   `placeholder="hint"`: Additional attributes 

### Common Patterns

Common ref patterns include various HTML elements and their typical attributes :
*   `@e1 [button] "Submit"` 
*   `@e2 [input type="email"]` 
*   `@e4 [a href="/page"] "Link Text"` 

## Troubleshooting

### "Ref not found" Error
This error typically means the ref has changed or is no longer valid. The solution is to re-snapshot the page .

### Element Not Visible in Snapshot
If an element is not visible, you may need to scroll to reveal it or wait for dynamic content to load before taking a new snapshot .

### Too Many Elements
To manage a large number of elements, you can snapshot a specific container or use `get text` for content-only extraction .

## Notes
The `agent-browser` tool is a browser automation CLI for AI agents . The core workflow involves navigating, snapshotting to get refs, interacting using those refs, and re-snapshotting after page changes . The `capture-workflow.sh` script provides an example of using `agent-browser` commands, including `snapshot -i`, to extract content and structure from web pages . The `packages/coding-agent/src/lsp/render.ts` file contains logic for rendering references, but this appears to be related to an LSP (Language Server Protocol) feature for displaying code references rather than the `agent-browser`'s web element references . Similarly, `packages/coding-agent/src/modes/subagent-view/subagent-index.ts` and `packages/coding-agent/test/subagent-sidebar-hotpath.test.ts` deal with `SubagentViewRef` and `SubagentIndexSnapshot`, which are internal data structures for managing subagent artifacts and their references, not directly related to the `@refs` used for browser interaction   . The `packages/coding-agent/src/tools/browser.ts` file implements the `Browser` tool, which includes the `observe` action that generates the accessibility snapshot used to create these refs .

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_d1caca6b-0587-4ddf-b70c-95d26d7b3ca5

