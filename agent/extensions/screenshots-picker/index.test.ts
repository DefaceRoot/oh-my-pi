import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
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
		const previousTmux = Bun.env.TMUX;
		(TERMINAL as unknown as { imageProtocol: ImageProtocol | null }).imageProtocol = ImageProtocol.Kitty;
		delete Bun.env.TMUX;
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
			if (previousTmux === undefined) {
				delete Bun.env.TMUX;
			} else {
				Bun.env.TMUX = previousTmux;
			}
		}
	});

	test("requests non-image redraws when no inline image protocol is available", async () => {
		const originalProtocol = TERMINAL.imageProtocol;
		(TERMINAL as unknown as { imageProtocol: ImageProtocol | null }).imageProtocol = null;
		try {
			const cwd = createTempDir("overlay-picker-no-protocol");
			const screenshotsDir = join(cwd, "screenshots");
			const screenshotPath = join(screenshotsDir, "selection-2026-03-07.png");
			mkdirSync(screenshotsDir, { recursive: true });
			tempDirs.push(cwd);
			await writeTinyPng(screenshotPath);

			let showCommand: ((args: string[], ctx: ExtensionContext) => Promise<void>) | undefined;
			const customCalls: Array<{ options?: { overlay?: boolean } }> = [];
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
						await factory({ requestRender: (force?: boolean) => renderCalls.push(force) } as never, {} as never, {} as never, () => {});
						return null;
					},
					notify: () => {},
					setStatus: () => {},
					setEditorText: (text) => {
						editorTextCalls.push(text);
					},
				},
			} as ExtensionContext);

			expect(customCalls).toHaveLength(1);
			expect(customCalls[0]?.options).toEqual({ overlay: true });
			expect(editorTextCalls).toEqual([""]);
			expect(renderCalls).not.toContain(true);
		} finally {
			(TERMINAL as unknown as { imageProtocol: ImageProtocol | null }).imageProtocol = originalProtocol;
		}
	});

});


describe("screenshots picker Kitty tmux placeholder previews", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("renders placeholder output and requests text redraws for Kitty inside tmux when kitten is available", async () => {
		const originalProtocol = TERMINAL.imageProtocol;
		const previousTmux = Bun.env.TMUX;
		const originalWhich = Bun.which;
		(TERMINAL as unknown as { imageProtocol: ImageProtocol | null }).imageProtocol = ImageProtocol.Kitty;
		Bun.env.TMUX = "/tmp/tmux-session";
		try {
			const cwd = createTempDir("overlay-picker-tmux-kitty");
			const screenshotsDir = join(cwd, "screenshots");
			const screenshotPath = join(screenshotsDir, "selection-2026-03-07.png");
			const kittenPath = join(cwd, "kitten");
			mkdirSync(screenshotsDir, { recursive: true });
			tempDirs.push(cwd);
			await writeTinyPng(screenshotPath);
			await Bun.write(
				kittenPath,
				[
					"#!/bin/sh",
					"printf 'PLACEHOLDER-LINE-1\\nPLACEHOLDER-LINE-2\\n'",
				].join("\n"),
			);
			chmodSync(kittenPath, 0o755);
			(Bun as typeof Bun & { which: (binary: string) => string | null }).which = (binary: string) =>
				binary === "kitten" ? kittenPath : null;

			let showCommand: ((args: string[], ctx: ExtensionContext) => Promise<void>) | undefined;
			const renderCalls: Array<boolean | undefined> = [];
			const customCalls: Array<{ options?: { overlay?: boolean } }> = [];
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
						const component = await factory(
							{ requestRender: (force?: boolean) => renderCalls.push(force) } as never,
							{ fg: (_token: string, value: string) => value, bold: (value: string) => value } as never,
							{} as never,
							() => {},
						);
						const initialLines = component.render?.(120) ?? [];
						expect(initialLines.join("\n")).toContain("[Loading preview:");
						await Bun.sleep(50);
						const renderedLines = component.render?.(120) ?? [];
						expect(renderedLines.join("\n")).toContain("PLACEHOLDER-LINE-1");
						component.handleInput?.("z");
						const afterZoomAttempt = component.render?.(120) ?? [];
						expect(afterZoomAttempt.join("\n")).not.toContain("Screenshot Inspector");
						component.dispose?.();
						return null;
					},
					notify: () => {},
					setStatus: () => {},
					setEditorText: () => {},
				},
			} as ExtensionContext);

			expect(customCalls).toHaveLength(1);
			expect(customCalls[0]?.options).toEqual({ overlay: true });
			expect(renderCalls).not.toContain(true);
		} finally {
			(TERMINAL as unknown as { imageProtocol: ImageProtocol | null }).imageProtocol = originalProtocol;
			(Bun as typeof Bun & { which: typeof Bun.which }).which = originalWhich;
			if (previousTmux === undefined) {
				delete Bun.env.TMUX;
			} else {
				Bun.env.TMUX = previousTmux;
			}
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

describe("screenshots picker Kitty tmux cleanup", () => {
	test("wraps Kitty delete sequences for tmux passthrough", () => {
		const previousTmux = Bun.env.TMUX;
		Bun.env.TMUX = "/tmp/tmux-session";
		try {
			const deleteKittyImage = (_testExports as { deleteKittyImage?: (imageId: number) => string }).deleteKittyImage;
			expect(deleteKittyImage).toBeDefined();
			expect(deleteKittyImage?.(9000).startsWith("\x1bPtmux;")).toBe(true);
			expect(deleteKittyImage?.(9000)).toContain("\x1b\x1b_Ga=d,d=I,i=9000");
		} finally {
			if (previousTmux === undefined) {
				delete Bun.env.TMUX;
			} else {
				Bun.env.TMUX = previousTmux;
			}
		}
	});
});

describe("screenshots picker preview backend selection", () => {
	test("keeps direct Kitty previews outside tmux unchanged", () => {
		const resolvePreviewBackend = (_testExports as {
			resolvePreviewBackend?: (options: {
				terminalImageProtocol: ImageProtocol | null;
				inTmux: boolean;
				kittenBinary: string | null;
				kittyBinary: string | null;
			}) => unknown;
		}).resolvePreviewBackend;

		expect(resolvePreviewBackend).toBeDefined();
		expect(
			resolvePreviewBackend?.({
				terminalImageProtocol: ImageProtocol.Kitty,
				inTmux: false,
				kittenBinary: null,
				kittyBinary: null,
			}),
		).toEqual({
			kind: "kitty-direct",
			protocol: ImageProtocol.Kitty,
			usesInlineImages: true,
			supportsKittyInspector: true,
		});
	});

	test("prefers kitten placeholders for Kitty inside tmux when kitten is available", () => {
		const resolvePreviewBackend = (_testExports as {
			resolvePreviewBackend?: (options: {
				terminalImageProtocol: ImageProtocol | null;
				inTmux: boolean;
				kittenBinary: string | null;
				kittyBinary: string | null;
			}) => unknown;
		}).resolvePreviewBackend;

		expect(resolvePreviewBackend).toBeDefined();
		expect(
			resolvePreviewBackend?.({
				terminalImageProtocol: ImageProtocol.Kitty,
				inTmux: true,
				kittenBinary: "/usr/bin/kitten",
				kittyBinary: null,
			}),
		).toEqual({
			kind: "kitty-tmux-placeholder",
			protocol: null,
			usesInlineImages: false,
			supportsKittyInspector: false,
			tool: { command: "/usr/bin/kitten", prefixArgs: ["icat"] },
		});
	});

	test("falls back to kitty +kitten when kitten is absent but kitty is installed", () => {
		const resolvePreviewBackend = (_testExports as {
			resolvePreviewBackend?: (options: {
				terminalImageProtocol: ImageProtocol | null;
				inTmux: boolean;
				kittenBinary: string | null;
				kittyBinary: string | null;
			}) => unknown;
		}).resolvePreviewBackend;

		expect(resolvePreviewBackend).toBeDefined();
		expect(
			resolvePreviewBackend?.({
				terminalImageProtocol: ImageProtocol.Kitty,
				inTmux: true,
				kittenBinary: null,
				kittyBinary: "/usr/bin/kitty",
			}),
		).toEqual({
			kind: "kitty-tmux-placeholder",
			protocol: null,
			usesInlineImages: false,
			supportsKittyInspector: false,
			tool: { command: "/usr/bin/kitty", prefixArgs: ["+kitten", "icat"] },
		});
	});

	test("falls back to text rendering for Kitty inside tmux when no placeholder tooling is available", () => {
		const resolvePreviewBackend = (_testExports as {
			resolvePreviewBackend?: (options: {
				terminalImageProtocol: ImageProtocol | null;
				inTmux: boolean;
				kittenBinary: string | null;
				kittyBinary: string | null;
			}) => unknown;
		}).resolvePreviewBackend;

		expect(resolvePreviewBackend).toBeDefined();
		expect(
			resolvePreviewBackend?.({
				terminalImageProtocol: ImageProtocol.Kitty,
				inTmux: true,
				kittenBinary: null,
				kittyBinary: null,
			}),
		).toEqual({
			kind: "text-fallback",
			protocol: null,
			usesInlineImages: false,
			supportsKittyInspector: false,
			hint: " (install kitten, kitty, or chafa for tmux previews)",
		});
	});
});

describe("screenshots picker placeholder command builder", () => {
	test("builds kitten icat placeholder invocations with screen-relative placement", () => {
		const buildKittyTmuxPlaceholderCommand = (_testExports as {
			buildKittyTmuxPlaceholderCommand?: (options: {
				tool: { command: string; prefixArgs: string[] };
				imagePath: string;
				imageId: number;
				placement: { columns: number; rows: number; col: number; row: number };
				window: { columns: number; rows: number; widthPx: number; heightPx: number };
			}) => { command: string; args: string[] };
		}).buildKittyTmuxPlaceholderCommand;

		expect(buildKittyTmuxPlaceholderCommand).toBeDefined();
		expect(
			buildKittyTmuxPlaceholderCommand?.({
				tool: { command: "/usr/bin/kitten", prefixArgs: ["icat"] },
				imagePath: "/tmp/example.png",
				imageId: 9000,
				placement: { columns: 70, rows: 14, col: 47, row: 18 },
				window: { columns: 120, rows: 40, widthPx: 1200, heightPx: 800 },
			}),
		).toEqual({
			command: "/usr/bin/kitten",
			args: [
				"icat",
				"--stdin=no",
				"--use-window-size",
				"120,40,1200,800",
				"--transfer-mode",
				"stream",
				"--passthrough",
				"tmux",
				"--place",
				"70x14@47x18",
				"--image-id",
				"9000",
				"/tmp/example.png",
			],
		});
	});
});
