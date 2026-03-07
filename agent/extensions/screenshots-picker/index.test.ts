import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FORK_REFRESH_STATUS_KEY } from "../../../packages/coding-agent/src/modes/action-buttons";
import {
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

describe("screenshots picker status integration", () => {
	test("orders the staged-screenshots indicator after the built-in workflow buttons and renders a compact pill", () => {
		expect(screenshotsStatusKey > FORK_REFRESH_STATUS_KEY).toBe(true);
		expect(renderStagedStatusText(2)).toContain("Shots 2");
		expect(renderStagedStatusText(2)).toContain("\x1b[");
	});
});
