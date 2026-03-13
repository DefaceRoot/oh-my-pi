# Bash Mode

This response provides detailed documentation for the 'Bash Mode' feature, as found in the 'Usage' section of the `DefaceRoot/oh-my-pi` project's `README.md` . It covers how to execute bash commands, control their output visibility in the LLM context, and includes relevant parameters for the `BashTool`.

## Bash Mode

Bash Mode allows you to execute shell commands directly within the agent's interface . This is useful for interacting with the file system, running scripts, or performing other command-line operations.

### Execution and Context Inclusion

To execute a bash command and include its output in the LLM (Large Language Model) context, prefix the command with `!` . This means the agent will be able to "see" and process the output of the command.

```bash
!git status 
!ls -la 
```

### Excluding Output from LLM Context

If you want to execute a command but prevent its output from being included in the LLM's context, prefix the command with `!!` . This is useful for commands that produce very verbose output or are not directly relevant to the agent's current reasoning process.

```bash
!!git status 
```

### Real-time Output and Cancellation

Output from bash commands streams in real-time . You can press `Escape` to cancel a running command .

### Bash Tool Parameters

The `BashTool` supports several parameters to control command execution and output . These parameters are defined in the `BashToolInput` interface  and the `bashSchemaBase` and `bashSchemaWithAsync` TypeBox schemas .

| Parameter | Type | Description |
|---|---|---|
| `command` | string | The shell command to execute . |
| `timeout` | number | The maximum time in seconds to wait for the command to complete. The default is 300 seconds . |
| `cwd` | string | The working directory for the command. Defaults to the current working directory of the session . |
| `head` | number | Return only the first N lines of output . |
| `tail` | number | Return only the last N lines of output . |
| `pty` | boolean | If `true`, the command runs in PTY (pseudo-terminal) mode, which is necessary for interactive commands like `sudo`, `ssh`, `top`, or `less` . |
| `async` | boolean | If `true`, the command runs in the background and immediately returns a job ID. The result will be delivered as a follow-up . |

### PTY Mode

When a bash command requires a real terminal or user input, you should explicitly set `pty: true` in the `bash` tool call . This is crucial for commands such as `sudo`, `ssh`, password prompts, or interactive confirmations . The system does not automatically assume PTY mode .

### Output Truncation and Artifacts

The `BashTool` handles output truncation. If the output exceeds a certain size (e.g., `DEFAULT_MAX_BYTES` ), it will be truncated, and the full output will be stored as an artifact . A `truncationWarning` will be included in the output metadata .

### Error Handling

The `BashTool` catches and reports errors such as command cancellation, timeouts, and non-zero exit codes . For example, if a command exits with a non-zero status, a `ToolError` will be thrown .

### Persistent Shell

The system can be configured to use a persistent shell session on Unix-like systems, which allows environment variables to persist between commands . This behavior can be enabled via settings or the `OMP_SHELL_PERSIST=1` environment variable .

## Notes

The provided context primarily focuses on the `BashTool` implementation and its parameters, as well as how bash commands are handled within the interactive agent environment. The `README.md`  provides the user-facing documentation for "Bash Mode" under the "Usage" section. The `packages/coding-agent/src/tools/bash.ts`  file defines the `BashTool` and its schema, while `packages/coding-agent/test/tools.test.ts`  contains tests demonstrating its functionality, including output streaming, artifact storage, and error handling. The `agent/AGENTS.md`  file provides guidelines for using PTY mode.

Wiki pages you might want to explore:
- [Tools System (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#6)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_440fa4dc-ba2a-4d8b-90c6-bbbc3167d6d7

