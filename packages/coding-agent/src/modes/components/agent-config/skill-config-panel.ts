import { type Component, Input, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { SkillConfig } from "../../../config/roles-config";
import type { Skill } from "../../../extensibility/skills";
import { fuzzyFilter } from "../../../utils/fuzzy";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

/** The three states a skill can occupy in a SkillConfig. */
type SkillMode = "auto" | "frontmatter" | "disabled";

export interface SkillConfigPanelCallbacks {
	/** Fired whenever the user cycles a skill's mode. New config is complete. */
	onConfigChange: (config: SkillConfig) => void;
	/** Fired on interrupt/escape. Optional: caller decides whether to close. */
	onClose?: () => void;
}

export interface SkillConfigPanelOptions {
	skills: Skill[];
	skillConfig: SkillConfig;
	callbacks: SkillConfigPanelCallbacks;
}

/** Maximum rows to show in the visible window before scrolling. */
const MAX_VISIBLE = 15;

/**
 * Skills tab panel for the Agent Configuration modal.
 *
 * Displays each discovered skill with a mode indicator and lets the user
 * cycle through modes with Space: disabled → auto → frontmatter → disabled.
 *
 *   [A] = auto (green)       — skill content injected at every invocation
 *   [F] = frontmatter (yellow) — skill injected when referenced in frontmatter
 *   [ ] = disabled (dim)     — skill not included
 */
export class SkillConfigPanel implements Component {
	#skills: Skill[];
	#skillConfig: SkillConfig;
	readonly #callbacks: SkillConfigPanelCallbacks;
	#selectedIndex = 0;
	#scrollOffset = 0;
	#filterMode = false;
	readonly #searchInput = new Input();
	/** Subset of #skills after applying the current search query. */
	#filteredSkills: Skill[] = [];

	constructor(options: SkillConfigPanelOptions) {
		this.#skills = options.skills;
		this.#skillConfig = cloneSkillConfig(options.skillConfig);
		this.#callbacks = options.callbacks;
		this.#refreshFilteredSkills();
	}

	/** Refresh the skills list and config without resetting the selection. */
	update(skills: Skill[], skillConfig: SkillConfig): void {
		const selectedSkillName = this.#filteredSkills[this.#selectedIndex]?.name;
		this.#skills = skills;
		this.#skillConfig = cloneSkillConfig(skillConfig);
		this.#refreshFilteredSkills();
		const maxScrollOffset = Math.max(0, this.#filteredSkills.length - MAX_VISIBLE);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxScrollOffset);
		if (selectedSkillName) {
			const preferredIndex = this.#filteredSkills.findIndex(skill => skill.name === selectedSkillName);
			if (preferredIndex >= 0) {
				this.#selectedIndex = preferredIndex;
			} else {
				this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#filteredSkills.length - 1));
			}
		} else {
			this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#filteredSkills.length - 1));
		}
		this.#ensureVisible(this.#selectedIndex);
	}

	invalidate(): void {
		// Stateless render; nothing to flush.
	}

	isFilterMode(): boolean {
		return this.#filterMode;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		this.#searchInput.focused = this.#filterMode;

		// Legend row: keep it compact so it fits on narrow terminals.
		const auto = theme.fg("success", "[A]");
		const fm = theme.fg("warning", "[F]");
		const off = theme.fg("dim", "[ ]");
		lines.push(truncateToWidth(` ${auto}=auto  ${fm}=frontmatter  ${off}=off   space:cycle`, width));
		lines.push("");
		lines.push(
			truncateToWidth(
				` ${theme.fg(this.#filterMode ? "accent" : "dim", "Search")} ${theme.fg("dim", this.#filterMode ? "(editing)" : "(/ to edit)")}`,
				width,
			),
			truncateToWidth(this.#searchInput.render(width)[0] ?? "> ", width),
			"",
		);

		if (this.#skills.length === 0) {
			lines.push(theme.fg("muted", "  No skills discovered."));
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", this.#renderFooterHint()), width));
			return lines;
		}

		if (this.#filteredSkills.length === 0) {
			lines.push(theme.fg("dim", "  No matching skills."));
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", this.#renderFooterHint()), width));
			return lines;
		}

		this.#ensureVisible(this.#selectedIndex);

		if (this.#scrollOffset > 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▲ more"), width));
		}

		const endIdx = Math.min(this.#scrollOffset + MAX_VISIBLE, this.#filteredSkills.length);

		for (let i = this.#scrollOffset; i < endIdx; i++) {
			const skill = this.#filteredSkills[i];
			if (!skill) continue;

			const isSelected = i === this.#selectedIndex;
			const mode = this.#getMode(skill.name);
			const modeTag = this.#renderModeTag(mode);

			// Allocate remaining width to the skill name (tag is 3 chars + 1 space).
			const nameMaxWidth = Math.max(4, width - visibleWidth(modeTag) - 2);
			let nameStr = truncateToWidth(skill.name, nameMaxWidth);
			if (isSelected) {
				nameStr = theme.fg("accent", theme.bold(nameStr));
			} else if (mode === "disabled") {
				nameStr = theme.fg("dim", nameStr);
			}

			lines.push(truncateToWidth(` ${modeTag} ${nameStr}`, width));
		}

		if (endIdx < this.#filteredSkills.length) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▼ more"), width));
		}

		// Description for the currently selected skill.
		const selectedSkill = this.#filteredSkills[this.#selectedIndex];
		if (selectedSkill?.description) {
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", `  ${selectedSkill.description}`), width));
		}

		lines.push("");
		lines.push(truncateToWidth(theme.fg("dim", this.#renderFooterHint()), width));

		return lines;
	}

	handleInput(data: string): void {
		if (this.#filterMode) {
			this.#handleFilterInput(data);
			return;
		}

		if (matchesKey(data, "up") || data === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#selectedIndex = Math.max(0, Math.min(this.#filteredSkills.length - 1, this.#selectedIndex + 1));
			return;
		}
		if (data === "/") {
			this.#filterMode = true;
			return;
		}
		if (data === " " || matchesKey(data, "space")) {
			this.#cycleMode();
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#callbacks.onClose?.();
		}
	}

	#getMode(skillName: string): SkillMode {
		if (this.#skillConfig.auto.includes(skillName)) return "auto";
		if (this.#skillConfig.frontmatter.includes(skillName)) return "frontmatter";
		return "disabled";
	}

	#renderModeTag(mode: SkillMode): string {
		switch (mode) {
			case "auto":
				return theme.fg("success", "[A]");
			case "frontmatter":
				return theme.fg("warning", "[F]");
			case "disabled":
				return theme.fg("dim", "[ ]");
		}
	}

	/**
	 * Cycle the selected skill's mode: disabled → auto → frontmatter → disabled.
	 * Emits the updated SkillConfig immediately via onConfigChange.
	 */
	#cycleMode(): void {
		const skill = this.#filteredSkills[this.#selectedIndex];
		if (!skill) return;

		const current = this.#getMode(skill.name);
		const newConfig: SkillConfig = {
			auto: this.#skillConfig.auto.filter(n => n !== skill.name),
			frontmatter: this.#skillConfig.frontmatter.filter(n => n !== skill.name),
		};

		if (current === "disabled") {
			// disabled → auto
			newConfig.auto.push(skill.name);
		} else if (current === "auto") {
			// auto → frontmatter
			newConfig.frontmatter.push(skill.name);
		}
		// frontmatter → disabled: both lists already exclude the name, done.

		this.#skillConfig = newConfig;
		this.#callbacks.onConfigChange(newConfig);
	}

	#handleFilterInput(data: string): void {
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#filterMode = false;
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#filterMode = false;
			this.#searchInput.setValue("");
			this.#refreshFilteredSkills();
			this.#selectedIndex = 0;
			return;
		}
		const selectedSkillName = this.#filteredSkills[this.#selectedIndex]?.name;
		this.#searchInput.handleInput(data);
		this.#refreshFilteredSkills();
		if (selectedSkillName) {
			const preferredIndex = this.#filteredSkills.findIndex(skill => skill.name === selectedSkillName);
			this.#selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
		} else {
			this.#selectedIndex = 0;
		}
		this.#scrollOffset = 0;
	}

	/** Recompute #filteredSkills from #skills + current search query. */
	#refreshFilteredSkills(): void {
		const query = this.#searchInput.getValue().trim();
		this.#filteredSkills = query
			? fuzzyFilter(this.#skills, query, skill => `${skill.name} ${skill.description ?? ""}`)
			: this.#skills;
	}

	/** Footer hint that matches the current input mode and selection state. */
	#renderFooterHint(): string {
		if (this.#filterMode) {
			return "  enter:done  esc:clear search";
		}
		if (this.#skills.length === 0 || this.#filteredSkills.length === 0) {
			return "  /:search  esc:close";
		}
		return "  ↑/↓:navigate  space:cycle  /:search  esc:close";
	}

	/** Adjust #scrollOffset so that idx falls within the visible window. */
	#ensureVisible(idx: number): void {
		if (idx < this.#scrollOffset) {
			this.#scrollOffset = idx;
		} else if (idx >= this.#scrollOffset + MAX_VISIBLE) {
			this.#scrollOffset = idx - MAX_VISIBLE + 1;
		}
	}
}

function cloneSkillConfig(config: SkillConfig): SkillConfig {
	return { auto: [...config.auto], frontmatter: [...config.frontmatter] };
}
