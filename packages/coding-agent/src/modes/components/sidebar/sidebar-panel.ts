import type { Component } from "@oh-my-pi/pi-tui";
import type { SidebarModel } from "./model";
import { renderSidebar } from "./render";

export class SidebarPanelComponent implements Component {
	#model: SidebarModel | undefined;
	#cachedWidth: number | undefined;
	#cachedModel: SidebarModel | undefined;
	#cachedLines: string[] | undefined;

	update(model: SidebarModel): void {
		this.#model = model;
		this.#cachedWidth = undefined;
		this.#cachedModel = undefined;
		this.#cachedLines = undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (this.#cachedLines && this.#cachedWidth === safeWidth && this.#cachedModel === this.#model) {
			return this.#cachedLines;
		}

		const model: SidebarModel = this.#model ? { ...this.#model, width: safeWidth } : { width: safeWidth };
		const lines = renderSidebar(model);
		this.#cachedWidth = safeWidth;
		this.#cachedModel = this.#model;
		this.#cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.#cachedWidth = undefined;
		this.#cachedModel = undefined;
		this.#cachedLines = undefined;
	}
}
