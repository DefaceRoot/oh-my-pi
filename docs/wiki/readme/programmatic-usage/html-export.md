# HTML Export

This document provides detailed documentation for the 'HTML Export' feature, focusing on its programmatic usage within the codebase. It covers how to export session data to an HTML file, including command-line usage, API calls, and the underlying architecture and features of the exported HTML.

## Programmatic Usage

The HTML export functionality allows you to convert session files and JSON event logs into a human-readable HTML format. This can be done via the command line or programmatically through the `AgentSession` class.

### Command Line Interface (CLI) 

You can export a session to HTML directly from the command line using the `--export` flag .

**Usage:**
```bash
omp --export session.jsonl              # Auto-generated filename 
omp --export session.jsonl output.html  # Custom filename 
```
The `--export` flag is defined in `packages/coding-agent/src/commands/launch.ts` .

### `AgentSession` API 

The `AgentSession` class provides an asynchronous method `exportToHtml` to export the current session to an HTML file .

```typescript
async exportToHtml(outputPath?: string): Promise<string> { 
  const themeName = getCurrentThemeName(); 
  return exportSessionToHtml(this.sessionManager, this.state, { outputPath, themeName }); 
}
```
This method takes an optional `outputPath` string. If not provided, a filename will be auto-generated . It returns a Promise that resolves to the path of the exported file . The `exportToHtml` function internally uses `exportSessionToHtml` from `packages/coding-agent/src/export/html/` to perform the export, passing the `sessionManager`, current `state`, and an object containing the `outputPath` and `themeName` .

### RPC Mode 

In RPC mode, clients can trigger HTML export using the `client.exportHtml()` method .

```typescript
test("should export to HTML", async () => { 
  await client.start(); 
  await client.promptAndWait("Hello"); 
  const result = await client.exportHtml(); 
  expect(result.path).toBeDefined(); 
  expect(result.path.endsWith(".html")).toBe(true); 
  expect(fs.existsSync(result.path)).toBe(true); 
});
```
This test case demonstrates that `client.exportHtml()` returns an object with a `path` property pointing to the generated HTML file .

## HTML Export Features

The exported HTML includes several features for improved readability and navigation.

### Structure and Content 

The HTML export uses a template defined in `packages/coding-agent/src/export/html/template.html` . This template includes:
*   A sidebar for navigation .
*   A main content area for messages .
*   An image modal for displaying images .
*   Session data embedded as a JSON script .
*   External libraries like `marked.min.js` for Markdown parsing and `highlight.min.js` for syntax highlighting .

The template is bundled at compile-time for improved performance  and is auto-generated into `packages/coding-agent/src/export/html/template.generated.ts` .

### Sidebar Navigation 

The HTML export includes a tree visualization sidebar for navigating session branches . The sidebar provides filtering options:
*   **Default**: Hides settings entries .
*   **No-tools**: Default minus tool results .
*   **User**: Only user messages .
*   **Labeled**: Only labeled entries .
*   **All**: Shows everything .

### Keyboard Shortcuts 

The HTML export supports keyboard shortcuts :
*   `Ctrl+T`: Toggles thinking blocks .
*   `Ctrl+O`: Toggles tool outputs .

### Theming and Syntax Highlighting 

The HTML export supports theme-configurable background colors via an optional `export` section in the theme JSON . Syntax highlighting uses theme colors and matches TUI rendering . Code blocks in markdown and tool outputs are highlighted using `highlight.js` .

The `template.js` file configures `marked` to use `highlight.js` for code blocks :
```javascript
marked.use({ 
  breaks: true, 
  gfm: true, 
  renderer: { 
    code(token) { 
      const code = token.text; 
      const lang = token.lang; 
      let highlighted; 
      if (lang && hljs.getLanguage(lang)) { 
        try { 
          highlighted = hljs.highlight(code, { language: lang }).value; 
        } catch { 
          highlighted = escapeHtml(code); 
        } 
      } else { 
        try { 
          highlighted = hljs.highlightAuto(code).value; 
        } catch { 
          highlighted = escapeHtml(code); 
        } <cite repo="DefaceRoot/oh-my-pi" path="packages/

Wiki pages you might want to explore:
- [Context Management (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3.2)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_053e7183-ef9e-45e7-b736-3d13c93c0dbb

