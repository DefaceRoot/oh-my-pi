# Using Refs

This document provides detailed information on "Using Refs" within the `agent-browser` tool, as described in the `snapshot-refs.md` wiki page. It covers how to interact with elements using references, the lifecycle of these references, and best practices for their effective use. 

## Using Refs 

Once you have obtained references (refs) from a snapshot, you can interact directly with the elements on the page using `agent-browser` commands. 

### Code Examples 

Here are examples of how to use refs with common `agent-browser` commands: 

*   **Clicking an element**: To click a button with ref `@e6`, you would use `agent-browser click @e6`. 
*   **Filling an input field**: To fill an email input with ref `@e10`, use `agent-browser fill @e10 "user@example.com"`.  Similarly, for a password input with ref `@e11`, use `agent-browser fill @e11 "password123"`. 
*   **Submitting a form**: To submit a form by clicking a button with ref `@e12`, use `agent-browser click @e12`. 

## Ref Lifecycle 

It is crucial to understand that refs are invalidated when the page's Document Object Model (DOM) changes.  This means that after any action that modifies the page, such as a click that triggers navigation or dynamic content loading, you must re-snapshot to obtain new, valid refs. 

### Example of Ref Invalidation 

1.  **Initial Snapshot**: `agent-browser snapshot -i` might return `@e1 [button] "Next"`. 
2.  **Page Change**: Clicking this button, `agent-browser click @e1`, triggers a page change. 
3.  **Re-snapshot Required**: After the page change, you *must* re-snapshot using `agent-browser snapshot -i`.  The element previously referenced as `@e1` will now refer to a different element, for example, `@e1 [h1] "Page 2"`. 

## Best Practices 

To ensure reliable interactions, follow these best practices: 

### 1. Always Snapshot Before Interacting 

Always perform a snapshot to get current refs before attempting to interact with elements. 

*   **Correct Workflow**: 
    ```bash
    agent-browser open https://example.com
    agent-browser snapshot -i          # Get refs first
    agent-browser click @e1            # Use ref
    ```
*   **Incorrect Workflow**: Attempting to use a ref before a snapshot will result in an error as the ref does not exist yet. 
    ```bash
    agent-browser open https://example.com
    agent-browser click @e1            # Ref doesn't exist yet!
    ```

### 2. Re-Snapshot After Navigation 

After navigating to a new page, always re-snapshot to get updated refs for the new page's elements. 

```bash
agent-browser click @e5            # Navigates to new page
agent-browser snapshot -i          # Get new refs
agent-browser click @e1            # Use new refs
``` 

### 3. Re-Snapshot After Dynamic Changes 

If an action causes dynamic changes on the current page (e.g., opening a dropdown or loading new content), re-snapshot to capture the newly visible elements and their refs. 

```bash
agent-browser click @e1            # Opens dropdown
agent-browser snapshot -i          # See dropdown items
agent-browser click @e7            # Select item
``` 

### 4. Snapshot Specific Regions 

For complex pages, you can snapshot specific areas to reduce the output and focus on relevant elements. 

```bash
# Snapshot just the form
agent-browser snapshot @e9
``` 

## Ref Notation Details 

The snapshot output provides a compact representation of elements using a specific notation: 

```
@e1 [tag type="value"] "text content" placeholder="hint"
│    │   │             │               │
│    │   │             │               └─ Additional attributes
│    │   │             └─ Visible text
│    │   └─ Key attributes shown
│    └─ HTML tag name
└─ Unique ref ID
``` 

*   **Unique ref ID**: `@e1` is a unique identifier for the element. 
*   **HTML tag name**: `[tag]` indicates the HTML tag of the element (e.g., `button`, `input`, `a`). 
*   **Key attributes shown**: `type="value"` displays important attributes like `type` for inputs. 
*   **Visible text**: `"text content"` shows the visible text associated with the element. 
*   **Additional attributes**: `placeholder="hint"` includes other relevant attributes. 

### Common Patterns 

Here are some common ref patterns you might encounter: 

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

## Troubleshooting 

### "Ref not found" Error 

If you receive a "Ref not found" error, it likely means the ref has changed or is no longer valid. 

*   **Solution**: Re-snapshot the page using `agent-browser snapshot -i` to get updated refs. 

### Element Not Visible in Snapshot 

If an element you expect to see is not present in the snapshot output: 

*   **Scroll to reveal**: The element might be off-screen. Scroll the page using `agent-browser scroll --bottom` and then re-snapshot. 
*   **Wait for dynamic content**: If the element loads dynamically, you might need to wait for it to appear using `agent-browser wait 1000` (for 1000 milliseconds) before taking another snapshot. 

### Too Many Elements 

If the snapshot output contains too many elements, making it difficult to find the desired ref: 

*   **Snapshot specific container**: You can narrow down the snapshot to a specific container using its ref, e.g., `agent-browser snapshot @e5`. 
*   **Extract content only**: For content extraction, consider using `agent-browser get text @e5` to retrieve only the text content of a specific element. 

## Notes

The provided documentation is directly extracted from the `agent/skills/agent-browser/references/snapshot-refs.md` file.  Other files like `agent/skills/agent-browser/SKILL.md` <cite repo="DefaceRoot/oh-my-pi" path="agent/skills/agent-browser/SK

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_b5054596-9f4f-416e-a71f-59f8717b67ae

