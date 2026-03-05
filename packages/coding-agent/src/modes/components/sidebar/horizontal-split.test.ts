import { describe, expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import chalk from "chalk";
import { HorizontalSplit } from "./horizontal-split";

class StubComponent implements Component {
	constructor(
		private readonly renderImpl: (width: number) => string[],
		private readonly onInvalidate?: () => void,
	) {}

	render(width: number): string[] {
		return this.renderImpl(width);
	}

	invalidate(): void {
		this.onInvalidate?.();
	}
}

describe("HorizontalSplit", () => {
	test("pads left side using visible width with ANSI content", () => {
		const left = new StubComponent(() => [chalk.green("left")]);
		const right = new StubComponent(() => [chalk.blue("r")]);
		const split = new HorizontalSplit(left, right, 6);

		const lines = split.render(18);
		expect(lines).toHaveLength(1);
		const [leftPart, rightPart] = lines[0]!.split("│");
		expect(visibleWidth(leftPart!)).toBe(11);
		expect(rightPart).toContain("r");
	});

	test("renders all lines from both sides", () => {
		const left = new StubComponent(() => ["l1", "l2"]);
		const right = new StubComponent(() => ["r1"]);
		const split = new HorizontalSplit(left, right, 4);

		const lines = split.render(12);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("r1");
		expect(lines[1]).toContain("│");
	});

	test("invalidates both children", () => {
		let leftInvalidated = 0;
		let rightInvalidated = 0;
		const left = new StubComponent(
			() => [],
			() => {
				leftInvalidated += 1;
			},
		);
		const right = new StubComponent(
			() => [],
			() => {
				rightInvalidated += 1;
			},
		);
		const split = new HorizontalSplit(left, right, 4);

		split.invalidate();
		expect(leftInvalidated).toBe(1);
		expect(rightInvalidated).toBe(1);
	});
});
