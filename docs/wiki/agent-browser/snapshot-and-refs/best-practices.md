# Best Practices

This response provides the complete documentation for the 'Best Practices' section within the 'Snapshot and Refs' wiki page, located at `agent/skills/agent-browser/references/snapshot-refs.md` . It includes all subsections and code examples as requested.

## Best Practices for Snapshot and Refs

The 'Best Practices' section outlines four key recommendations for effectively using snapshots and references (refs) with the `agent-browser` tool . These practices ensure that the AI agent interacts with the web page correctly and efficiently by maintaining valid references to elements.

### 1. Always Snapshot Before Interacting

It is crucial to take a snapshot of the page to generate refs *before* attempting to interact with any elements . Refs do not exist until a snapshot is taken .

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

Refs are invalidated when the page changes, such as after navigating to a new URL . Therefore, a new snapshot must be taken to obtain updated refs for the new page .

```bash
agent-browser click @e5            # Navigates to new page
agent-browser snapshot -i          # Get new refs
agent-browser click @e1            # Use new refs
``` 

### 3. Re-Snapshot After Dynamic Changes

If a page undergoes dynamic changes, such as opening a dropdown or loading new content without a full page navigation, a new snapshot is required to capture the newly visible or altered elements and their corresponding refs .

```bash
agent-browser click @e1            # Opens dropdown
agent-browser snapshot -i          # See dropdown items
agent-browser click @e7            # Select item
``` 

### 4. Snapshot Specific Regions

For complex web pages, it can be beneficial to snapshot only a specific region or element to reduce the amount of context and focus on relevant elements . This can be achieved by providing a ref to the `snapshot` command .

```bash
# Snapshot just the form
agent-browser snapshot @e9
``` 

## Notes

The `snapshot-refs.md` document also details how refs work, the `snapshot` command, how to use refs, ref lifecycle, ref notation details, and troubleshooting tips . The `agent-browser snapshot -i` command is recommended for interactive snapshots . The `capture-workflow.sh` script provides an example of using `agent-browser snapshot -i` to capture page structure . Other documents like `AGENTS.md` and `SKILL.md` in `agent/skills/vercel-react-best-practices` and `agent/skills/e2e-testing-patterns` discuss best practices in different contexts (React/Next.js performance and E2E testing, respectively) and are not directly related to the `Snapshot and Refs` best practices   .

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_4d29af5a-7ae6-4294-b0da-7567f7faef94

