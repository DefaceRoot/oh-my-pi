# Skills

The user is asking for documentation on "Skills" within the "Extensions" section, which refers to the capability packages loaded on-demand in the `oh-my-pi` codebase. This documentation will cover how skills are defined, discovered, configured, and integrated into the system.

## Skills Documentation

Skills are capability packages that are loaded on-demand to extend the agent's behavior and knowledge base . They are defined using Markdown files with frontmatter and are discovered from various locations .

### Skill Definition

A skill is typically defined in a `SKILL.md` file within a dedicated directory . The file includes frontmatter for metadata like `name` and `description`, followed by the skill's content .

**Example Skill File (`SKILL.md`)** :
```markdown
---
name: brave-search
description: Web search via Brave Search API.
---

# Brave Search
```
The `description` field is crucial for matching the skill to relevant tasks, and the `name` defaults to the folder name if omitted .

### Skill Locations and Discovery

Skills are automatically discovered and loaded from several predefined locations . These locations include user-specific and project-specific directories, as well as directories compatible with other tools like Claude Code and Codex CLI .

Common locations for skill discovery are:
*   Global user skills: `~/.omp/agent/skills/*/SKILL.md` 
*   Project-level skills: `.omp/skills/*/SKILL.md` 
*   Claude Code compatible skills: `~/.claude/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md` 
*   Codex CLI compatible skills: `~/.codex/skills/*/SKILL.md`, `.codex/skills/*/SKILL.md` 

The `loadSkills` function in `packages/coding-agent/src/extensibility/skills.ts` is the primary entry point for loading skills . It uses the capability API to discover skills and filters them based on various criteria, including source enablement, include/ignore patterns, and categories .

The `scanSkillsFromDir` function in `packages/coding-agent/src/discovery/helpers.ts` is responsible for scanning a given directory for `SKILL.md` files . It reads the content, parses the frontmatter, and creates `Skill` objects .

### Configuration

Skill loading can be controlled through settings and CLI flags .
*   **Disable Skills**: You can disable skills globally using `omp --no-skills` CLI flag or by setting `skills.enabled: false` in your configuration .
*   **Custom Directories**: Skills can also be loaded from custom directories specified in the configuration .
*   **Filtering**: The `loadSkills` function supports `includeSkills` and `ignoredSkills` glob patterns to control which skills are loaded .

The `LoadSkillsOptions` interface defines the available configuration options for loading skills .

### Integration and Usage

Once loaded, skills are listed in the system prompt with their descriptions, allowing the agent to use them when needed . The agent can load skill content via the `read` tool .

Internal URLs are used to reference skill content:
*   `skill://<name>`: Refers to the `SKILL.md` content of a skill .
*   `skill://<name>/<path>`: Refers to a relative file within a skill's directory .

In `bash`, these URIs auto-resolve to filesystem paths .

The `InputController` in `packages/coding-agent/src/modes/controllers/input-controller.ts` handles `/skill:` commands, loading the skill content and prompting the session with a custom message .

## Notes

The prompt specifically asked for the "Skills" wiki page under the "Extensions" section. While there is a "Context Management" wiki page provided, its content is not directly related to "Skills" and has been excluded from this documentation. The `README.md` file also mentions "Skills" under "Extensions" and points to a dedicated "Skills Documentation" . The provided snippets from `packages/coding-agent/src/prompts/system/system-prompt.md`, `packages/coding-agent/CHANGELOG.md`, `packages/coding-agent/DEVELOPMENT.md`, `packages/coding-agent/src/extensibility/skills.ts`, `packages/coding-agent/src/discovery/helpers.ts`, `packages/coding-agent/src/modes/controllers/input-controller.ts`, and various `agent/skills/*/SKILL.md` files were used to construct this documentation.

Wiki pages you might want to explore:
- [Context Management (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3.2)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_37b70d31-0630-4e48-86ff-66132a8872cb

