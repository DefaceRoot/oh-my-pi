import { describe, expect, test } from "bun:test";
import path from "node:path";

const interactiveModePath = path.join(import.meta.dir, "../src/modes/interactive-mode.ts");

async function readInteractiveModeSource(): Promise<string> {
	return Bun.file(interactiveModePath).text();
}

describe("InteractiveMode lazygit footer registration", () => {
	test("always registers lazygit status with the button normal text during setup", async () => {
		const source = await readInteractiveModeSource();

		expect(source).toMatch(
			/this\.statusLine\.setHookStatus\(\s*LAZYGIT_BUTTON\.statusKey,\s*LAZYGIT_BUTTON\.normalText\s*\);/,
		);
	});
});
