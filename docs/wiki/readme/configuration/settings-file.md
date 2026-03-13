# Settings File

This document provides comprehensive details about the 'Settings File' within the codebase, covering its storage locations, structure, example configurations, and migration notes. The settings system uses a `Settings` singleton for synchronized access and background persistence, with a unified schema defined in `settings-schema.ts` .

## Settings File Overview

Global settings are stored in `~/.omp/agent/config.yml` . Project-specific overrides can be loaded from files like `.omp/settings.json` . The `Settings` class manages this configuration, handling loading, merging, overriding, and saving .

### Storage Locations 
*   **Global Settings**: `~/.omp/agent/config.yml` 
*   **Project Overrides**: Discovered from project settings files, commonly `.omp/settings.json` 

## Settings Class Architecture

The `Settings` class, located in `packages/coding-agent/src/config/settings.ts` , is a singleton responsible for managing durable configuration .

### Source Layers 
The settings are composed from multiple layers:
*   **Global config**: From `<agentDir>/config.yml`, stored in `#global` 
*   **Project capability settings**: Loaded via `loadCapability(settingsCapability.id, { cwd })`, stored in `#project` 
*   **Runtime overrides**: Not persisted, stored in `#overrides` 
*   **Effective merged view**: The final combined settings, stored in `#merged` 

### Persistence Behavior 
*   `set(path, value)`: Updates `#global`, tracks modified paths, debounces saves, and then persists .
*   `#saveNow()`: Uses `withFileLock` to re-read the current YAML, applies only modified paths, and writes back via `Bun.write` .
*   `flush()`: Forces any pending writes .
*   `#migrateFromLegacy()`: At startup, migrates old `settings.json` or `agent.db` values into `config.yml` .

### Setting Hooks 
Runtime side effects of setting changes are handled by `SETTING_HOOKS` , which centralizes actions like theme mapping, symbol preset, and color-blind mode adjustments . For example, `theme.dark` and `theme.light` settings trigger `setAutoThemeMapping` , `symbolPreset` calls `setSymbolPreset` , and `colorBlindMode` calls `setColorBlindMode` .

## Configuration Snippets

### Global `config.yml` Example 

```yaml
theme:
  dark: titanium
  light: light

modelRoles:
  default: anthropic/claude-sonnet-4-20250514
  orchestrator: anthropic/claude-opus-4-1:high
  explore: anthropic/claude-sonnet-4-20250514
defaultThinkingLevel: high
enabledModels:
  - anthropic/*
  - "*gpt*"
  - gemini-2.5-pro:high

steeringMode: one-at-a-time
followUpMode: one-at-a-time
interruptMode: immediate

shellPath: C:\\path\\to\\bash.exe
hideThinkingBlock: false
collapseChangelog: false

disabledProviders: []
disabledExtensions: []

compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000

skills:
  enabled: true

retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000

terminal:
  showImages: true

topP: -1 # Nucleus sampling (0-1, -1 = provider default)
topK: -1 # Top-K tokens (-1 = provider default)
minP: -1 # Minimum probability (0-1, -1 = provider default)

display:
  tabWidth: 4 # Tab rendering width (.editorconfig integration)

async:
  enabled: false
  maxJobs: 100

task:
  eager: false
  isolation:
    mode: none # none | worktree | fuse-overlay | fuse-projfs
    merge: patch # patch | branch
```


### Theme Configuration 
The system supports automatic dark/light theme switching based on terminal appearance .
```yaml
theme:
  dark: titanium
  light: light
```


## Legacy Migration Notes 
*   `settings.json` is migrated to `config.yml` .
*   `queueMode` is now `steeringMode` .
*   Flat `theme: "..."` is replaced by `theme.dark` and `theme.light` .

## Settings Schema 
The `SETTINGS_SCHEMA` in `packages/coding-agent/src/config/settings-schema.ts` defines all settings with their types, default values, and optional UI metadata . This provides a unified, type-safe way to access settings .

Examples of settings defined in the schema include:
*   `theme.dark` and `theme.light` for terminal themes .
*   `symbolPreset` for icon/symbol style .
*   `colorBlindMode` for accessibility .
*   `display.tabWidth` for tab rendering .
*   `defaultThinkingLevel` for reasoning depth .
*   `compaction.enabled`, `compaction.localStrategy`, `compaction.remoteEnabled`, and `checkpoint.enabled` for context management .

## Notes
The `Settings` class replaces the legacy `SettingsManager` , offering a synchronous `get`/`set` API . For testing, `Settings.isolated()` can create independent instances , and `_resetSettingsForTest()` is available to reset the global singleton . The `config-cli.ts` file demonstrates how settings can be listed, retrieved, set, and reset via the command line .

Wiki pages you might want to explore:
- [Context Management (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3.2)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_c2da3b0e-efac-40b7-84db-76c7b1e464eb

