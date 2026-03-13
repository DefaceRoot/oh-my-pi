# Troubleshooting

You are asking for the complete documentation of the 'Troubleshooting' section within the 'Snapshot and Refs' wiki page. This documentation is located in the `agent/skills/agent-browser/references/snapshot-refs.md` file .

## Troubleshooting

This section addresses common issues encountered when working with snapshots and refs .

### "Ref not found" Error

If you encounter a "Ref not found" error, it typically means the reference (`@e1`, `@e2`, etc.) you are trying to use has changed or is no longer valid . This often happens after page navigation or dynamic content updates .

To resolve this, you must re-snapshot the page to obtain new, valid references .

```bash
# Ref may have changed - re-snapshot
agent-browser snapshot -i 
```

### Element Not Visible in Snapshot

If an element you expect to see is not present in the snapshot output, it might be off-screen or loaded dynamically .

You can try the following solutions:

*   **Scroll to reveal the element**: Scroll the page to bring the element into the viewport and then take a new snapshot .
    ```bash
    # Scroll to reveal element
    agent-browser scroll --bottom 
    agent-browser snapshot -i 
    ```
*   **Wait for dynamic content**: If the element loads dynamically, wait for a short period before taking the snapshot .
    ```bash
    # Or wait for dynamic content
    agent-browser wait 1000 
    agent-browser snapshot -i 
    ```

### Too Many Elements

When dealing with complex pages that result in a large number of elements in the snapshot, you can refine your snapshot to focus on specific regions or extract content directly .

*   **Snapshot a specific container**: If you are interested in a particular section of the page, you can snapshot only that container using its ref .
    ```bash
    # Snapshot specific container
    agent-browser snapshot @e5 
    ```
*   **Use `get text` for content-only extraction**: If you only need the text content of an element, use the `agent-browser get text` command .
    ```bash
    # Or use get text for content-only extraction
    agent-browser get text @e5 
    ```

## Notes

The `snapshot-refs.md` document is a key reference for understanding how `agent-browser` handles element references and provides guidance on best practices and troubleshooting . The `SKILL.md` file also reiterates the importance of re-snapshotting after page changes, which is a common cause of "Ref not found" errors . The `commands.md` file provides a comprehensive list of all `agent-browser` commands, including `snapshot`, `scroll`, and `get text`, which are used in the troubleshooting examples .

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_9ded9884-7deb-4d23-a98f-bbdb3278e972

