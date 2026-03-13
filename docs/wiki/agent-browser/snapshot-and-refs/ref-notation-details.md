# Ref Notation Details

This response details the 'Ref Notation Details' section from the `Snapshot and Refs` wiki page, explaining the structure of reference notations and providing common patterns for various HTML elements. 

## Ref Notation Details

The ref notation provides a compact way to represent elements on a web page for AI agents.  Each ref follows a specific structure: 

```
@e1 [tag type="value"] "text content" placeholder="hint"
│    │   │             │               │
│    │   │             │               └─ Additional attributes
│    │   │             └─ Visible text
│    │   └─ Key attributes shown
│    └─ HTML tag name
└─ Unique ref ID
``` 

*   **Unique ref ID**: This is a unique identifier for the element, starting with `@e` followed by a number (e.g., `@e1`). 
*   **HTML tag name**: The HTML tag of the element (e.g., `button`, `input`, `a`). 
*   **Key attributes shown**: Important attributes of the HTML element, such as `type="email"` for an input field. 
*   **Visible text**: The text content displayed within the element, if any (e.g., `"Submit"` for a button). 
*   **Additional attributes**: Other relevant attributes like `placeholder="hint"`. 

### Common Patterns

Here are some common examples of ref notations for various HTML elements: 

*   **Button with text**: `@e1 [button] "Submit"` 
*   **Email input**: `@e2 [input type="email"]` 
*   **Password input**: `@e3 [input type="password"]` 
*   **Anchor link**: `@e4 [a href="/page"] "Link Text"` 
*   **Dropdown**: `@e5 [select]` 
*   **Text area**: `@e6 [textarea] placeholder="Message"` 
*   **Container (when relevant)**: `@e7 [div class="modal"]` 
*   **Image**: `@e8 [img alt="Logo"]` 
*   **Checked checkbox**: `@e9 [checkbox] checked` 
*   **Selected radio button**: `@e10 [radio] selected` 

## Notes

The provided context focuses specifically on the `Ref Notation Details` section of the `snapshot-refs.md` document.  Other sections of the document, such as "How Refs Work" or "Troubleshooting", were not included as they were outside the scope of the user's specific request.  The `agent-browser` tool is used to generate these snapshots and interact with the elements using these refs. 

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_f9f5d1b0-5a05-4f4e-ad13-2e31dc932df7

