# Themes

This document provides detailed information about the theming system in oh-my-pi, covering built-in themes, automatic switching, custom themes, and the structure of theme definition files. You can configure themes via the `/settings` command or directly in the `~/.omp/agent/config.yml` file. 

## Themes 

oh-my-pi includes several built-in themes, such as `dark`, `light`, and various bundled variants. 

### Automatic Dark/Light Switching 

The system automatically detects your terminal's appearance using Mode 2031, native macOS CoreFoundation FFI, or a `COLORFGBG` fallback.  Based on this detection, it switches between the `theme.dark` and `theme.light` configurations. 

You can select a theme using the `/settings` command or by modifying the `~/.omp/agent/config.yml` file. 

**Configuration Snippet:** 
```yaml
theme:
  dark: titanium
  light: light
```

### Custom Themes 

You can create custom themes by placing JSON files in `~/.omp/agent/themes/*.json`.  These custom themes support live editing, meaning changes are applied immediately upon saving the files.  If a custom theme is invalid or malformed, the application will gracefully fall back to the dark theme. 

### Theme Structure and Color Tokens

Themes are defined by a JSON schema, which specifies the `name` of the theme and a `colors` object containing various color tokens.  Additionally, themes can define `vars` for reusable color variables. 

The `colors` object includes a comprehensive list of color tokens for different UI elements.  As of a recent update, the total color count increased from 46 to 50, with new tokens added for `selectedBg`, `customMessageBg`, `customMessageText`, and `customMessageLabel`. 

**Example Theme Definition (excerpt from `dark.json`):** 
```json
{
	"$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/theme-schema.json",
	"name": "dark",
	"vars": {
		"cyan": "#0088fa",
		"blue": "#178fb9",
		"green": "#89d281",
		"red": "#fc3a4b",
		"yellow": "#e4c00f",
		"gray": "#777d88",
		"dimGray": "#5f6673",
		"darkGray": "#3d424a",
		"accent": "#febc38",
		"selectedBg": "#31363f",
		"userMsgBg": "#221d1a",
		"toolPendingBg": "#1d2129",
		"toolSuccessBg": "#161a1f",
		"toolErrorBg": "#291d1d",
		"customMsgBg": "#2a2530"
	},
	"colors": {
		"accent": "accent",
		"border": "blue",
		"borderAccent": "cyan",
		"borderMuted": "darkGray",
		"success": "green",
		"error": "red",
		"warning": "yellow",
		"muted": "gray",
		"dim": "dimGray",
		"text": "",
		"thinkingText": "gray",
		"selectedBg": "selectedBg",
		"userMessageBg": "userMsgBg",
		"userMessageText": "",
		"customMessageBg": "customMsgBg",
		"customMessageText": "",
		"customMessageLabel": "#b281d6",
		"toolPendingBg": "toolPendingBg",
		"toolSuccessBg": "toolSuccessBg",
		"toolErrorBg": "toolErrorBg",
		"toolTitle": "",
		"toolOutput": "gray",
		"mdHeading": "#febc38",
		"mdLink": "#0088fa",
		"mdLinkUrl": "dimGray",
		"mdCode": "#e5c1ff",
		"mdCodeBlock": "#9CDCFE",
		"mdCodeBlockBorder": "darkGray",
		"mdQuote": "gray",
		"mdQuoteBorder": "darkGray",
		"mdHr": "darkGray",
		"mdListBullet": "accent",
		"toolDiffAdded": "green",
		"toolDiffRemoved": "red",
		"toolDiffContext": "gray",
		"link": "#0088fa",
		"syntaxComment": "#6A9955",
		"syntaxKeyword": "#569CD6",
		"syntaxFunction": "#DCDCAA"
	}
}
```

The `ThemeJsonSchema` in `packages/coding-agent/src/modes/theme/theme.ts` defines the expected structure for theme JSON files.  This schema includes properties for `name`, optional `vars` (reusable color variables), and the required `colors` object.  Each color property within the `colors` object references a `ColorValueSchema`, which can be a hex color string, a variable reference, an empty string for terminal default, or a 256-color palette index. 

**Key Color Tokens:** 
*   `accent`: Primary accent color (e.g., logo, selected items, cursor).
*   `border`: Normal borders.
*   `borderAccent`: Highlighted borders.
*   `borderMuted`: Subtle borders.
*   `success`, `error`, `warning`: Colors for status messages.
*   `muted`, `dim`, `text`, `thinkingText`: General text colors.
*   `selectedBg`: Background for selected/highlighted items.
*   `userMessageBg`, `userMessageText`: Colors for user messages.
*   `customMessageBg`, `customMessageText`, `customMessageLabel`: Colors for hook-injected messages.
*   `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`: Backgrounds for tool execution states.
*   `toolTitle`, `toolOutput`: Colors for tool execution box titles and output.
*   `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`: Colors for Markdown rendering.
*   `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`: Colors for tool diff displays.
*   `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`: Colors for syntax highlighting.
*   `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`: Colors for thinking level borders.
*   `bashMode`, `pythonMode`: Colors for specific modes.
*   `statusLineBg`, `statusLineSep`, `statusLineModel`, `statusLinePath`, `statusLineGitClean`, `statusLineGitDirty`, `statusLineContext`, `statusLineSpend`, `statusLineStaged`, `statusLineDirty`, `statusLineUntracked`, `statusLineOutput`, `statusLineCost`, `statusLineSubagents`: Colors for the footer status line.

### Built-in Themes

The codebase includes several default themes, both dark and light variants.  These are located in `packages/coding-agent/src/modes/theme/defaults/`. 

**Dark Themes:**
*   `dark` 
*   `dark-abyss` 
*   `dark-cavern` 
*   `dark-ember` 
*   `dark-equinox` 
*   `dark-forest` 
*   `dark-github` 
*   `dark-midnight` 
*   `dark-rainforest` 
*   `dark-synthwave` 
*   `dark-twilight` 
*   `obsidian` 

**Light Themes:**
*   `light-dunes` 
*   `light-forest` 
*   `light-one` 
*   `light-paper` 
*   `light-sunset` 
*   `light-synthwave` 
*   `light-wetland` 

## Notes

The provided context does not include a dedicated "Themes" wiki page under an "Extensions" section. The information above is synthesized from the `README.md` file and various theme definition files within the `packages/coding-agent/src/modes/theme/` directory.    The `CHANGELOG.md` also provided details on recent theme-related updates, such as the addition of new color tokens and improved error handling for malformed themes. 

Wiki pages you might want to explore:
- [Overview (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#1)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_94125871-da55-43ee-8ee1-855080fb6a07

