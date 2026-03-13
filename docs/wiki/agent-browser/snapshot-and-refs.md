# Snapshot and Refs

This document provides a detailed explanation of "Snapshot and Refs" based on the `snapshot-refs.md` file.  It covers how refs work, the `snapshot` command, using refs for interaction, their lifecycle, best practices, notation details, and troubleshooting. 

## Snapshot and Refs

"Snapshot and Refs" are compact element references designed to significantly reduce context usage for AI agents when interacting with web pages. 

### How Refs Work

Traditionally, AI agents parse the full DOM/HTML, then use CSS selectors for actions, which can consume a large number of tokens (approximately 3000-5000).  The `agent-browser` approach uses a compact snapshot where `@refs` are assigned to elements, enabling direct interaction with fewer tokens (approximately 200-400). 

### The Snapshot Command

The `agent-browser snapshot` command is used to generate these element references. 

*   **Basic snapshot**: `agent-browser snapshot` shows the page structure. 
*   **Interactive snapshot**: `agent-browser snapshot -i` is recommended for interactive elements. 

#### Snapshot Output Format

The output of a snapshot command provides a hierarchical view of interactive elements with assigned `@e` references. 

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

### Using Refs

Once refs are obtained, they can be used for direct interaction with elements. 

```bash
# Click the "Sign In" button
agent-browser click @e6

# Fill email input
agent-browser fill @e10 "user@example.com"

# Fill password
agent-browser fill @e11 "password123"

# Submit the form
agent-browser click @e12
``` 

### Ref Lifecycle

Refs are invalidated when the page changes.  It is crucial to re-snapshot to get new refs after any page modification. 

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

### Best Practices

1.  **Always Snapshot Before Interacting**: Obtain refs using `agent-browser snapshot -i` before attempting to interact with elements. 
2.  **Re-Snapshot After Navigation**: After navigating to a new page, always re-snapshot to get updated refs. 
3.  **Re-Snapshot After Dynamic Changes**: If dynamic content appears (e.g., a dropdown), re-snapshot to see the new elements. 
4.  **Snapshot Specific Regions**: For complex pages, you can snapshot specific areas using a ref to limit the output. 

### Ref Notation Details

A ref notation provides details about the element it represents: 

```
@e1 [tag type="value"] "text content" placeholder="hint"
│    │   │             │               │
│    │   │             │               └─ Additional attributes
│    │   │             └─ Visible text
│    │   └─ Key attributes shown
│    └─ HTML tag name
└─ Unique ref ID
``` 

#### Common Patterns

Examples of common ref patterns include buttons, input fields, links, and containers. 

```
@e1 [button] "Submit"                    # Button with text
@e2 [input type="email"]                 # Email input
@e3 [input type="password"]              # Password input
@e4 [a href="/page"] "Link Text"         # Anchor link
@e5 [select]                             # Dropdown
@e6 [textarea] placeholder="Message"     # Text area
@e7 [div class="modal"]                  # Container (when relevant)
@e8 [img alt="Logo"]                     # Image
@e9 [checkbox] checked                   # Checked checkbox
@e10 [radio] selected                    # Selected radio
``` 

### Troubleshooting

*   **"Ref not found" Error**: This usually means the ref has changed or is no longer valid. Re-snapshot the page. 
*   **Element Not Visible in Snapshot**: Scroll to reveal the element or wait for dynamic content to load, then re-snapshot. 
*   **Too Many Elements**: Snapshot a specific container using its ref to narrow down the scope, or use `get text` for content extraction. 

## Notes

The `agent-browser` tool is central to this functionality, as seen in `SKILL.md` which outlines the core workflow of navigate, snapshot, and interact.  The `capture-workflow.sh` script also demonstrates the use of `agent-browser snapshot -i` for capturing page structure.  The `packages/coding-agent/src/tools/browser.ts` file contains the implementation for the `observe` action, which is responsible for generating the accessibility snapshot that forms the basis of refs. 


View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_cb6b98aa-2171-4c31-9987-38b77c9ccb64

