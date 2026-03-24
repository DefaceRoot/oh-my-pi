Applies precise file edits using `LINE#ID` anchors from `read` output.

Read the file first. Copy anchors exactly from the latest `read` output. In one `edit` call, batch all edits for one file. After any successful edit, re-read before editing that file again.

<critical>
- Do not anchor insertions on blank lines or lone closers (`}`, `]`, `)`, `};`, `),`). Anchor on declaration/header lines.
- Use `{ block: ... }` whenever existing lines change, especially near block tails/closing delimiters.
- Use `{ append: ... }` / `{ prepend: ... }` only for self-contained new content. `content` must contain only newly introduced lines.
- For sibling insertions, prefer `{ prepend: ... }` on the next declaration over `{ append: ... }` on a previous closer.
- Match surrounding indentation exactly.
- If replacement emits a closing delimiter, make `loc.block.end` include the old matching closer to avoid duplicate boundaries.
</critical>

<workflow>
1. Read the file first to get fresh tags.
2. Submit one `edit` call per file with all operations batched.
3. Choose edits by owning structure, not smallest textual diff.
4. If editing around a block tail, expand to a range `block` that owns the tail.
</workflow>
<operations>
**Top level**
- `path` — file path
- `move` — optional rename target
- `delete` — optional whole-file delete
- `edits` — array of `{ loc, content }` entries

**Edit entry**: `{ loc, content }`
- `loc` — where to apply the edit (see below)
- `content` — replacement/inserted lines (array of strings preferred, `null` to delete)

**`loc` values**
- `"append"` / `"prepend"` — insert at end/start of file
- `{ append: "N#ID" }` / `{ prepend: "N#ID" }` — insert after/before anchored line
- `{ line: "N#ID" }` — replace exactly one anchored line
- `{ block: { pos: "N#ID", end: "N#ID" } }` — replace inclusive `pos..end`
</operations>

<rules>
1. Anchor on unique structural lines (function/class/declaration headers), never blank/closer lines.
2. `{ append: ... }` / `{ prepend: ... }` only when surrounding structure is unchanged.
3. If control flow, indentation, or closers change, use `{ block: ... }` range replace.
4. Before submitting a range `block`, compare the replacement last line with original line after `end`; extend `end` if they duplicate.
</rules>

<recovery>
- Tag mismatch (`>>>`): file moved since read. Use fresh tags from error; if unclear, re-read and retry with a simpler single-op edit.
- No-op (`identical`): do not resend same payload; re-read and adjust intended change.
</recovery>

<examples>
All examples below reference the same file, `util.ts`:
```ts
{{hlinefull  1 "// @ts-ignore"}}
{{hlinefull  2 "const timeout = 5000;"}}
{{hlinefull  3 "const tag = \"DO NOT SHIP\";"}}
{{hlinefull  4 ""}}
{{hlinefull  5 "function alpha() {"}}
{{hlinefull  6 "\tlog();"}}
{{hlinefull  7 "}"}}
{{hlinefull  8 ""}}
{{hlinefull  9 "function beta() {"}}
{{hlinefull 10 "\t// TODO: remove after migration"}}
{{hlinefull 11 "\tlegacy();"}}
{{hlinefull 12 "\ttry {"}}
{{hlinefull 13 "\t\treturn parse(data);"}}
{{hlinefull 14 "\t} catch (err) {"}}
{{hlinefull 15 "\t\tconsole.error(err);"}}
{{hlinefull 16 "\t\treturn null;"}}
{{hlinefull 17 "\t}"}}
{{hlinefull 18 "}"}}
```

<example name="replace a block body">
Replace only the catch body. Do not target the shared boundary line `} catch (err) {`.
```
{
  path: "util.ts",
  edits: [{
    loc: { block: { pos: {{hlineref 15 "\t\tconsole.error(err);"}}, end: {{hlineref 16 "\t\treturn null;"}} } },
    content: [
      "\t\tif (isEnoent(err)) return null;",
      "\t\tthrow err;"
    ]
  }]
}
```
</example>

<example name="replace one line">
```
{
  path: "util.ts",
  edits: [{
    loc: { line: {{hlineref 2 "const timeout = 5000;"}} },
    content: ["const timeout = 30_000;"]
  }]
}
```
</example>

<example name="delete a range">
```
{
  path: "util.ts",
  edits: [{
    loc: { block: { pos: {{hlineref 10 "\t// TODO: remove after migration"}}, end: {{hlineref 11 "\tlegacy();"}} } },
    content: null
  }]
}
```
</example>

<example name="insert before sibling">
When adding a sibling declaration, prefer `prepend` on the next declaration.
```
{
  path: "util.ts",
  edits: [{
    loc: { prepend: {{hlineref 9 "function beta() {"}} },
    content: [
      "function gamma() {",
      "\tvalidate();",
      "}",
      ""
    ]
  }]
}
```
</example>
</examples>

<critical>
- Make the minimum exact edit. Do not rewrite nearby code unless the consumed range requires it.
- Use anchors exactly as `N#ID` from the latest `read` output.
- `block` requires both `pos` and `end`. Other anchored ops require one anchor.
- Replace exactly the owned span. If `content` re-emits content beyond `end`, it will duplicate.
- **Boundary duplication trap**: when replacing a block, `end` must be the **last line of the block** (e.g. the closing `}`), not the last *content* line before it. Otherwise the closing delimiter survives and your replacement adds a second copy.
- Do not target shared boundary lines such as `} else {`, `} catch (…) {`, `}),`, or `},{`.
- For a block, either replace only the body or replace the whole block. Do not split block boundaries.
- `content` must be literal file content with matching indentation. If the file uses tabs, use real tabs.
- Do not use this tool to reformat or clean up unrelated code.
- Tags must be copied exactly from the most recent `read` output.
- After each successful edit call, re-read before another edit on the same file.
</critical>