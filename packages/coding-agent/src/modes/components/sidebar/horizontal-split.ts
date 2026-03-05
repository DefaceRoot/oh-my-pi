import type { Component } from "@oh-my-pi/pi-tui";
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

export class HorizontalSplit implements Component {
	constructor(
		private readonly left: Component,
		private readonly right: Component,
		private readonly rightWidth: number,
		private readonly separator = "│",
	) {}

	render(totalWidth: number): string[] {
		const safeTotalWidth = Math.max(1, Math.floor(totalWidth));
		const leftWidth = Math.max(0, safeTotalWidth - this.rightWidth - 1);
		const safeRightWidth = Math.max(0, safeTotalWidth - leftWidth - 1);
		const leftLines = this.left.render(leftWidth);
		const rightLines = this.right.render(safeRightWidth);
		const maxLines = Math.max(leftLines.length, rightLines.length);
		const result: string[] = [];

		for (let i = 0; i < maxLines; i += 1) {
			const leftLine = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const rightLine = truncateToWidth(rightLines[i] ?? "", safeRightWidth);
			const paddedLeft = padToWidth(leftLine, leftWidth);
			if (safeRightWidth === 0) {
				result.push(paddedLeft);
				continue;
			}
			result.push(paddedLeft + this.separator + rightLine);
		}

		return result;
	}

	invalidate(): void {
		this.left.invalidate?.();
		this.right.invalidate?.();
	}
}

function padToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	const pad = Math.max(0, width - visibleWidth(text));
	if (pad === 0) return text;
	return text + padding(pad);
}
