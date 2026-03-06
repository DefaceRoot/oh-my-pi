"""Agents View feature extensions.

This package collects all feature extension modules. Each module is imported
here so that its monkey-patches are applied when this package is loaded.
Import order matters: performance_cache first, visual_enhancements second,
then data helpers, then UI features, then integrations.
"""

import importlib
import logging

# Apply in dependency order (no circular deps since all use lazy import)
_FEATURE_MODULES = [
		# Foundation - must load first
		"performance_cache",          # LRU cache and smart refresh scheduling
		"visual_enhancements",        # Status icons, spinners, context bars
		# Data helpers
		"context_window_bar",         # Context window size/bar rendering
		"session_timeline",           # Activity sparklines
		"git_status_display",         # Ahead/behind, uncommitted, last commit
		"token_budget_bar",           # Token budget tracking and velocity
		"agent_health_monitor",       # Health scoring (0-100) per session
		"workspace_sync",             # Merge conflict / rebase / protected branch
		# Conversation and preview
		"conversation_preview",       # JSONL conversation view with role labels
		"task_list_panel",            # Persistent todo panel above preview
		"preview_search",             # Ctrl+F search within preview pane
		# Input and interaction
		"enhanced_input",             # History nav, readline keybindings, char count
		# Session creation
		"spawn_enhancements",         # Branch/worktree/model dropdowns in spawn dialog
		"yazzie_integration",         # Detect Yazzie CWD for new sessions
		# Help and navigation
		"help_screen_v2",             # Searchable, visually grouped help screen
		# Session management
		"session_pinning",            # Pin sessions to top, star favorites
		"session_export",             # Export to Markdown / copy to clipboard
		"session_labels",             # Custom emoji labels per session
		"session_notes",              # Per-session notes with persistence
		"session_fork",               # Fork a session to explore alternatives
		"multi_select",               # Multi-select for batch operations
		"auto_archive",               # Auto-archive old completed sessions
		# Analytics and monitoring
		"cost_tracker",               # Budget alerts, cost breakdown screen
		"activity_heatmap",           # 24h activity heatmap screen
		# Collaboration and broadcasting
		"broadcast_enhancements",     # Tag/status/role-based broadcast directives
		# Navigation enhancements
		"inline_subagent_tree",       # Expand/collapse subagent hierarchy in table
		"quick_actions",              # Space-bar context menu for sessions
		# Visual and theme
		"theme_enhancements",         # 4 new themes + theme picker screen
		# Status bar (last - wraps many existing features)
		"status_bar_enhancements",    # Enhanced stats bar with clock and modes
		# Command palette (absolute last)
		"command_palette_enhancements",  # More commands in command palette
]

_log = logging.getLogger(__name__)

for _mod_name in _FEATURE_MODULES:
		try:
				importlib.import_module(f"agents_view.features.{_mod_name}")
		except Exception as _e:
				_log.warning("Failed to load feature module %s: %s", _mod_name, _e)
