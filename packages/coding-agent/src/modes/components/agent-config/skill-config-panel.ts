import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { SkillConfig } from "../../../config/roles-config";
import type { Skill } from "../../../extensibility/skills";
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

	constructor(options: SkillConfigPanelOptions) {
		this.#skills = options.skills;
		this.#skillConfig = cloneSkillConfig(options.skillConfig);
		this.#callbacks = options.callbacks;
	}

	/** Refresh the skills list and config without resetting the selection. */
	update(skills: Skill[], skillConfig: SkillConfig): void {
		this.#skills = skills;
		this.#skillConfig = cloneSkillConfig(skillConfig);
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#skills.length - 1));
	}

	invalidate(): void {
		// Stateless render; nothing to flush.
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Legend row: keep it compact so it fits on narrow terminals.
		const auto = theme.fg("success", "[A]");
		const fm = theme.fg("warning", "[F]");
		const off = theme.fg("dim", "[ ]");
		lines.push(truncateToWidth(` ${auto}=auto  ${fm}=frontmatter  ${off}=off   space:cycle`, width));
		lines.push("");

		if (this.#skills.length === 0) {
			lines.push(theme.fg("muted", "  No skills discovered."));
			return lines;
		}

		this.#ensureVisible(this.#selectedIndex);

		if (this.#scrollOffset > 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▲ more"), width));
		}

		const endIdx = Math.min(this.#scrollOffset + MAX_VISIBLE, this.#skills.length);

		for (let i = this.#scrollOffset; i < endIdx; i++) {
			const skill = this.#skills[i];
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

		if (endIdx < this.#skills.length) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▼ more"), width));
		}

		// Description for the currently selected skill.
		const selectedSkill = this.#skills[this.#selectedIndex];
		if (selectedSkill?.description) {
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", `  ${selectedSkill.description}`), width));
		}

		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up") || data === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#selectedIndex = Math.max(0, Math.min(this.#skills.length - 1, this.#selectedIndex + 1));
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
		const skill = this.#skills[this.#selectedIndex];
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
