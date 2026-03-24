Execute shell commands for terminal tasks (git, package managers, builds, runtime commands).

<instruction>
- You **MUST** use `cwd` parameter to set working directory instead of `cd dir && …`
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values instead of inlining them into shell syntax; reference them from the command as `$NAME`
- Quote variable expansions like `"$NAME"` to preserve exact content and avoid shell parsing bugs
- PTY mode is opt-in: set `pty: true` only when command expects a real terminal (for example `sudo`, `ssh` where you need input from the user); default is `false`
- You **MUST** use `;` only when later commands should run regardless of earlier failures
- `skill://` URIs are auto-resolved to filesystem paths before execution
	- `python skill://<skill>/scripts/init.py` runs the script from the skill directory
	- `skill://<name>/<relative-path>` resolves within the skill's base directory
- Internal URLs are also auto-resolved to filesystem paths before execution.
{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you don't need immediate output; the call returns a background job ID and the result is delivered automatically as a follow-up.
- Use `read jobs://` to inspect all background jobs and `read jobs://<job-id>` for detailed status/output when needed.
- When you need to wait for async results before continuing, call `await` — it blocks until jobs complete. Do NOT poll `read jobs://` in a loop or yield and hope for delivery.
{{/if}}
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