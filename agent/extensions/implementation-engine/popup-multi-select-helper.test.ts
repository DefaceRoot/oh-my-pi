import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(implementationEnginePath).text();

describe("popup multi-select helper", () => {
	test("adds showMultiSelectPopupMenu with string[] selections", async () => {
		const content = await readExtensionSource();

		expect(content).toMatch(
			/async function showMultiSelectPopupMenu\(title: string, options: string\[\]\): Promise<string\[\]\s*\|\s*null>/,
		);
		expect(content).toMatch(/\["bash",\s*menuScript,\s*"--multi",\s*title,\s*\.\.\.options\]/);
	});

	test("uses tmux-unavailable fallback sentinel like single-select helper", async () => {
		const content = await readExtensionSource();

		expect(content).toMatch(
			/async function showMultiSelectPopupMenu[\s\S]*const inTmux = Boolean\(process\.env\.TMUX\);[\s\S]*if \(!inTmux\) \{[\s\S]*return null/,
		);
		expect(content).toMatch(
			/async function showMultiSelectPopupMenu[\s\S]*if \(!\(await Bun\.file\(menuScript\)\.exists\(\)\)\) \{[\s\S]*return null/,
		);
	});

	test("returns empty array for empty popup output", async () => {
		const content = await readExtensionSource();

		expect(content).toMatch(/if \(!out\.trim\(\)\) return \[\];/);
		expect(content).toMatch(/return out\.split\("\\n"\)\.map\(line => line\.trim\(\)\)\.filter\(Boolean\);/);
	});

	test("keeps single-select popup helper behavior intact", async () => {
		const content = await readExtensionSource();

		expect(content).toMatch(/async function showPopupMenu\(title: string, options: string\[\]\): Promise<string \| undefined>/);
		expect(content).toMatch(/\["bash",\s*menuScript,\s*title,\s*\.\.\.options\]/);
	});
});
