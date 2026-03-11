Execute shell commands for terminal tasks (git, package managers, builds, runtime commands).

<instruction>
- Always set working directory with `cwd` (do not `cd ... && ...`).
- Use `pty: true` only for commands requiring an interactive terminal.
- Chain with `;` only when later commands should run even if earlier ones fail.
- `skill://` and internal URIs auto-resolve to filesystem paths.
{{#if asyncEnabled}}- For long-running commands, use async mode and `await`; do not poll `read jobs://` in loops.{{/if}}
</instruction>

<output>
Returns command output and exit code. Truncated output is available via `artifact://<id>`.
</output>

<critical>
Use specialized tools for file/content operations:
- Read files/directories: `read`
- Search content: `grep`
- Find files: `find`
- Text edits: `edit`
- Structural search/rewrites: `ast_grep` / `ast_edit`
- File creation/replacement: `write`

Do not use bash `cat`, `ls`, `grep/rg`, `find`, `sed/awk/perl` for operations covered above.
Do not use `2>&1`/`2>/dev/null` (streams are already merged).
Do not pipe to `head`/`tail`; use tool parameters instead.
</critical>
