# The Snapshot Command

You are asking for the complete documentation of "The Snapshot Command" from the `Snapshot and Refs` section of the `agent/skills/agent-browser/references/snapshot-refs.md` file. This includes its purpose, usage, output format, and related best practices and troubleshooting. 

## Snapshot and Refs 

Snapshot and Refs are compact element references designed to significantly reduce context usage for AI agents. 

### How Refs Work 

Traditionally, AI agents parse the full DOM/HTML, then use CSS selectors to perform actions, which can consume approximately 3000-5000 tokens.  The `agent-browser` approach uses a compact snapshot to assign `@refs`, enabling direct interaction with a much lower token usage of around 200-400 tokens. 

## The Snapshot Command 

The `snapshot` command is used to capture the structure of a web page and assign references to interactive elements. 

### Usage 

*   **Basic snapshot**: `agent-browser snapshot`  This command shows the page structure. 
*   **Interactive snapshot (RECOMMENDED)**: `agent-browser snapshot -i`  This option provides interactive elements with assigned references. 
*   **Scope to CSS selector**: `agent-browser snapshot -s "#selector"`  This allows you to snapshot a specific region of the page. 
*   **Compact output**: `agent-browser snapshot -c` 
*   **Limit depth**: `agent-browser snapshot -d 3` 

### Snapshot Output Format 

The output of the `snapshot` command provides a structured representation of the web page, including page title, URL, and a hierarchical list of elements with their assigned `@refs`. 

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

@e7 [main]
  @e8 [h1] "Welcome"
  @e9 [form]
    @e10 [input type="email"] placeholder="Email"
    @e11 [input type="password"] placeholder="Password"
    @e12 [button type="submit"] "Log In"

@e13 [footer]
  @e14 [a] "Privacy Policy"
``` 

### Ref Notation Details 

Each ref follows a specific notation: 
`@e1 [tag type="value"] "text content" placeholder="hint"` 
*   `@e1`: Unique ref ID 
*   `[tag]`: HTML tag name 
*   `type="value"`: Key attributes shown 
*   `"text content"`: Visible text 
*   `placeholder="hint"`: Additional attributes 

Common patterns include: 
*   `@e1 [button] "Submit"`: Button with text 
*   `@e2 [input type="email"]`: Email input 
*   `@e9 [checkbox] checked`: Checked checkbox 

## Using Refs 

Once refs are obtained, you can interact directly with elements using commands like `click` and `fill`. 

Example interactions: 
*   Click a button: `agent-browser click @e6` 
*   Fill an email input: `agent-browser fill @e10 "user@example.com"` 
*   Submit a form: `agent-browser click @e12` 

## Ref Lifecycle 

Refs are invalidated when the page changes.  It is crucial to re-snapshot to get new refs after any page modification. 

Example of ref invalidation: 
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

### 1. Always Snapshot Before Interacting 

Always obtain refs using `agent-browser snapshot -i` before attempting to interact with elements. 

### 2. Re-Snapshot After Navigation 

After navigating to a new page, always re-snapshot to get updated refs. 

### 3. Re-Snapshot After Dynamic Changes 

If dynamic content loads (e.g., dropdowns, modals), re-snapshot to see the new elements. 

### 4. Snapshot Specific Regions 

For complex pages, you can snapshot specific areas using a ref to a container element. 

## Troubleshooting 

### "Ref not found" Error 

This error typically means the ref has changed or is no longer valid.  Re-snapshot the page to get updated refs. 

### Element Not Visible in Snapshot 

If an element is not appearing in the snapshot, it might be off-screen or dynamically loaded. 
*   Scroll to reveal the element: 
    ```bash
    agent-browser scroll --bottom
    agent-browser snapshot -i
    ``` 
*   Wait for dynamic content to load: 
    ```bash
    agent-browser wait 1000
    agent-browser snapshot -i
    ``` 

### Too Many Elements 

If the snapshot contains too many elements, you can narrow the scope. 
*   Snapshot a specific container: `agent-browser snapshot @

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_f1f4b5d2-880f-4559-899d-7b33919c3e9e

