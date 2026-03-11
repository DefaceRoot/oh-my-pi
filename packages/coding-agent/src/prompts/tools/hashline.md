Apply precise file edits using `LINE#ID` tags from `read`. Tags are stable anchors; stale tags fail safely.

<critical>
- Do not anchor insertions on blank lines or lone closers (`}`, `]`, `)`, `};`, `),`). Anchor on declaration/header lines.
- Use `replace` whenever existing lines change, especially near block tails/closing delimiters.
- Use `append`/`prepend` only for self-contained new content. `lines` must contain only newly introduced lines.
- For sibling insertions, prefer `prepend` on the next declaration over `append` on a previous closer.
- Match surrounding indentation exactly.
- If replacement emits a closing delimiter, make `end` include the old matching closer to avoid duplicate boundaries.
</critical>

<workflow>
1. Read the file first to get fresh tags.
2. Submit one `edit` call per file with all operations batched.
3. Choose edits by owning structure, not smallest textual diff.
4. If editing around a block tail, expand to a range `replace` that owns the tail.
</workflow>

<operations>
Payload shape: `{ path, edits[] }`
- `edits[n].op`: `replace` | `prepend` | `append`
- `edits[n].pos`: anchor tag (`N#ID`) or null (BOF/EOF insertion)
- `edits[n].end`: inclusive end tag for range `replace`
- `edits[n].lines`:
  - `[...]` insert/replace with those lines
  - `null` or `[]` delete (for `replace`)
  - `[""]` keep blank line

`move` and `delete` are top-level optional controls.
</operations>

<rules>
1. Anchor on unique structural lines (function/class/declaration headers), never blank/closer lines.
2. `append`/`prepend` only when surrounding structure is unchanged.
3. If control flow, indentation, or closers change, use range `replace`.
4. Before submitting a range `replace`, compare the replacement last line with original line after `end`; extend `end` if they duplicate.
</rules>

<recovery>
- Tag mismatch (`>>>`): file moved since read. Use fresh tags from error; if unclear, re-read and retry with a simpler single-op edit.
- No-op (`identical`): do not resend same payload; re-read and adjust intended change.
</recovery>

<critical>
- Tags must be copied exactly from the most recent `read` output.
- After each successful edit call, re-read before another edit on the same file.
- Do not use this tool for formatting-only changes.
- For `append`/`prepend`, do not re-emit surrounding existing delimiters or siblings.
</critical>
