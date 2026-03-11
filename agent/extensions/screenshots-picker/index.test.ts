import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { FORK_MERGE_STATUS_KEY } from "../../../packages/coding-agent/src/modes/action-buttons";
import screenshotsPickerExtension, {
	_testExports,
	type StagedImageState,
} from "./index";

const {
	consumeStagedInput,
	getScreenshotsFromSource,
	renderStagedStatusText,
	screenshotsStatusKey,
	resolveDefaultSources,
} = _testExports;

function createTempDir(label: string): string {
	return join(tmpdir(), `omp-screenshots-picker-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function writeTinyPng(path: string): Promise<void> {
	const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8B9pQAAAAASUVORK5CYII=", "base64");
	await Bun.write(path, data);
}

describe("screenshots picker source resolution", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("prefers the repo screenshots folder before env and platform defaults", () => {
		const cwd = createTempDir("cwd");
		const homeDir = createTempDir("home");
		const screenshotsDir = join(cwd, "screenshots");
		mkdirSync(screenshotsDir, { recursive: true });
		tempDirs.push(cwd, homeDir);

		const sources = resolveDefaultSources({
			configuredSources: [],
			cwd,
			homeDir,
			env: {
				OMP_SCREENSHOTS_DIR: "/tmp/from-env",
				PI_SCREENSHOTS_DIR: "/tmp/from-pi-env",
			},
			platform: "linux",
			exists: (candidate) => candidate === screenshotsDir,
		});

		expect(sources).toEqual([screenshotsDir, "/tmp/from-env", "/tmp/from-pi-env"]);
	});

	test("returns configured sources without adding defaults", () => {
		const cwd = createTempDir("configured");
		const homeDir = createTempDir("home-configured");
		tempDirs.push(cwd, homeDir);

		const sources = resolveDefaultSources({
			configuredSources: ["~/Pictures/Screenshots", "./captures/**/*.png"],
			cwd,
			homeDir,
			env: {},
			platform: "linux",
			exists: () => true,
		});

		expect(sources).toEqual(["~/Pictures/Screenshots", "./captures/**/*.png"]);
	});
});

describe("screenshots picker staged image handling", () => {
	test("appends staged screenshots to any existing pending images and clears staging", () => {
		const existingImages = [{ type: "image" as const, mimeType: "image/png", data: "existing" }];
		const stagedState: StagedImageState = {
			images: [
				{ type: "image", mimeType: "image/png", data: "first" },
				{ type: "image", mimeType: "image/jpeg", data: "second" },
			],
			paths: new Set(["/tmp/first.png", "/tmp/second.jpg"]),
		};

		const result = consumeStagedInput(existingImages, stagedState);

		expect(result.images).toEqual([
			{ type: "image", mimeType: "image/png", data: "existing" },
			{ type: "image", mimeType: "image/png", data: "first" },
			{ type: "image", mimeType: "image/jpeg", data: "second" },
		]);
		expect(result.nextState.images).toEqual([]);
		expect([...result.nextState.paths]).toEqual([]);
	});
});

describe("screenshots picker directory scanning", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("includes newly added images from the repo screenshots directory even when the filename is tool-specific", async () => {
		const cwd = createTempDir("repo-screenshots");
		const homeDir = createTempDir("repo-home");
		const screenshotsDir = join(cwd, "screenshots");
		mkdirSync(screenshotsDir, { recursive: true });
		tempDirs.push(cwd, homeDir);

		await Bun.write(join(screenshotsDir, "selection-2026-03-07.png"), "dummy-image-data");

		const screenshots = getScreenshotsFromSource("./screenshots", cwd, homeDir);

		expect(screenshots.map((entry) => entry.name)).toContain("selection-2026-03-07.png");
	});
});

describe("screenshots picker modal hosting", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("opens in overlay mode, defers status widget updates, and forces full redraws for Kitty previews", async () => {
		const originalProtocol = TERMINAL.imageProtocol;
		(TERMINAL as unknown as { imageProtocol: ImageProtocol | null }).imageProtocol = ImageProtocol.Kitty;
		try {
			const cwd = createTempDir("overlay-picker");
			const screenshotsDir = join(cwd, "screenshots");
			const screenshotPath = join(screenshotsDir, "selection-2026-03-07.png");
			mkdirSync(screenshotsDir, { recursive: true });
			tempDirs.push(cwd);
			await writeTinyPng(screenshotPath);

			let showCommand: ((args: string[], ctx: ExtensionContext) => Promise<void>) | undefined;
			const customCalls: Array<{ options?: { overlay?: boolean } }> = [];
			const statusCalls: Array<string | undefined> = [];
			const editorTextCalls: string[] = [];
			const renderCalls: Array<boolean | undefined> = [];
			const extensionApi = {
				on: () => {},
				registerCommand: (name: string, options: { handler: (args: string[], ctx: ExtensionContext) => Promise<void> }) => {
					if (name === "ss") {
						showCommand = options.handler;
					}
				},
				registerShortcut: () => {},
			} as unknown as ExtensionAPI;

			screenshotsPickerExtension(extensionApi);
			expect(showCommand).toBeDefined();

			await showCommand!([], {
				hasUI: true,
				cwd,
				ui: {
					custom: async (factory, options) => {
						customCalls.push({ options });
						const component = await factory({ requestRender: (force?: boolean) => renderCalls.push(force) } as never, {} as never, {} as never, () => {});
						component.handleInput?.(" ");
						expect(statusCalls).toEqual([]);
						return null;
					},
					notify: () => {},
					setStatus: (_key, text) => {
						statusCalls.push(text);
					},
					setEditorText: (text) => {
						editorTextCalls.push(text);
					},
				},
			} as ExtensionContext);

			expect(customCalls).toHaveLength(1);
			expect(customCalls[0]?.options).toEqual({ overlay: true });
			expect(editorTextCalls).toEqual([""]);
			expect(renderCalls).toContain(true);
			expect(statusCalls).toHaveLength(1);
			expect(statusCalls[0]).toContain("Shots 1");
		} finally {
			(TERMINAL as unknown as { imageProtocol: ImageProtocol | null }).imageProtocol = originalProtocol;
		}
	});
});


describe("screenshots picker status integration", () => {
	test("orders the staged-screenshots indicator after the built-in workflow buttons and renders a compact pill", () => {
		expect(screenshotsStatusKey > FORK_MERGE_STATUS_KEY).toBe(true);
		expect(renderStagedStatusText(2)).toContain("Shots 2");
		expect(renderStagedStatusText(2)).toContain("\x1b[");
	});
});
