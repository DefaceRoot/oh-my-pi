import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext, ImageContent } from "@oh-my-pi/pi-coding-agent";
import {
	Image,
	ImageProtocol,
	TERMINAL,
	calculateImageRows,
	encodeKitty,
	getCellDimensions,
	getImageDimensions as getTerminalImageDimensions,
	matchesKey,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

interface ScreenshotInfo {
	path: string;
	name: string;
	mtime: Date;
	size: number;
}

interface SourceTab {
	label: string;
	pattern: string;
	screenshots: ScreenshotInfo[];
}

interface PickerConfig {
	sources?: string[];
}

export interface StagedImageState {
	images: ImageContent[];
	paths: Set<string>;
}

interface ResolveSourcesOptions {
	configuredSources: string[];
	cwd: string;
	homeDir: string;
	env: Partial<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	exists: (candidate: string) => boolean;
}

interface ConsumedStagedInput {
	images: ImageContent[];
	nextState: StagedImageState;
}

const SCREENSHOT_PATTERNS = [
	/^Screenshot\s/i,
	/^Capture\s/i,
	/^Scherm/i,
	/^Bildschirmfoto/i,
	/^Captura\s/i,
	/^Istantanea/i,
	/^screenshot/i,
	/^screen-shot/i,
	/^screen_shot/i,
	/^capture/i,
	/^snapshot/i,
	/^shot/i,
	/^\d{4}-\d{2}-\d{2}[_-]\d{2}[_-]\d{2}/i,
	/^flameshot/i,
	/^spectacle/i,
	/^scrot/i,
	/^maim/i,
	/^grim/i,
];

const MAX_THUMB_SIZE = 5 * 1024 * 1024;
const SYNC_THUMB_SIZE = 300 * 1024;
const LIST_WIDTH = 45;
const LIST_VISIBLE_ITEMS = 10;
const PREVIEW_LINES = 14;
const PREVIEW_WIDTH_CAP = 70;
const ZOOM_PREVIEW_MIN_LINES = 18;
const ZOOM_PREVIEW_MAX_LINES = 28;
const ZOOM_PREVIEW_WIDTH_CAP = 120;
const ZOOM_LEVEL_MIN = 1;
const ZOOM_LEVEL_MAX = 6;
const ZOOM_LEVEL_STEP = 0.25;
const ZOOM_PAN_STEP_RATIO = 0.12;
const KITTY_IMAGE_ID = 9000;
const SCREENSHOT_REFRESH_INTERVAL_MS = 1000;
const SCREENSHOTS_STATUS_KEY = "zzz-screenshots-status";
const REPO_SCREENSHOTS_DIR = "screenshots";
const SETTINGS_CANDIDATES = [
	(cwd: string, homeDir: string) => join(cwd, ".omp", "settings.json"),
	(_cwd: string, homeDir: string) => join(homeDir, ".omp", "agent", "settings.json"),
];

function expandPath(candidate: string, homeDir = homedir()): string {
	if (candidate.startsWith("~/")) {
		return join(homeDir, candidate.slice(2));
	}
	return candidate;
}

function resolveSourcePath(candidate: string, baseDir: string, homeDir = homedir()): string {
	const expanded = expandPath(candidate, homeDir);
	if (expanded.startsWith("/")) {
		return expanded;
	}
	return resolve(baseDir, expanded);
}

function isGlobPattern(pattern: string): boolean {
	return /[*?[\]{}!]/.test(pattern);
}

function uniquePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const candidate of paths) {
		const normalized = candidate.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function getPlatformDefaultSources(options: ResolveSourcesOptions): string[] {
	if (options.platform === "darwin") {
		try {
			const configured = execSync("defaults read com.apple.screencapture location 2>/dev/null", {
				encoding: "utf-8",
			}).trim();
			if (configured && options.exists(configured)) {
				return [configured];
			}
		} catch {
			// Fall through to Desktop.
		}

		const desktop = join(options.homeDir, "Desktop");
		return options.exists(desktop) ? [desktop] : [];
	}

	if (options.platform === "linux") {
		const candidates = [
			join(options.homeDir, "Pictures", "Screenshots"),
			join(options.homeDir, "Pictures"),
			join(options.homeDir, "Screenshots"),
			join(options.homeDir, "Desktop"),
		];
		for (const candidate of candidates) {
			if (options.exists(candidate)) {
				return [candidate];
			}
		}
	}

	const desktop = join(options.homeDir, "Desktop");
	return options.exists(desktop) ? [desktop] : [];
}

function resolveDefaultSources(options: ResolveSourcesOptions): string[] {
	if (options.configuredSources.length > 0) {
		return [...options.configuredSources];
	}

	const defaults: string[] = [];
	const repoScreenshotsDir = join(options.cwd, REPO_SCREENSHOTS_DIR);
	if (options.exists(repoScreenshotsDir)) {
		defaults.push(repoScreenshotsDir);
	}

	const envSources = [options.env.OMP_SCREENSHOTS_DIR, options.env.PI_SCREENSHOTS_DIR].filter(
		(candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
	);
	defaults.push(...envSources);
	defaults.push(...getPlatformDefaultSources(options));

	return uniquePaths(defaults);
}

function loadPickerConfig(cwd: string, homeDir = homedir()): PickerConfig {
	for (const buildPath of SETTINGS_CANDIDATES) {
		const settingsPath = buildPath(cwd, homeDir);
		if (!existsSync(settingsPath)) {
			continue;
		}

		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
			const config = parsed.screenshotsPicker;
			if (isPickerConfig(config)) {
				return config;
			}
		} catch {
			// Ignore invalid JSON in extension-local config discovery.
		}
	}

	return {};
}

function isPickerConfig(value: unknown): value is PickerConfig {
	if (!value || typeof value !== "object") {
		return false;
	}

	const sources = (value as { sources?: unknown }).sources;
	if (sources === undefined) {
		return true;
	}

	return Array.isArray(sources) && sources.every((item) => typeof item === "string");
}

function isImageFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp");
}

function isDedicatedScreenshotDirectory(directory: string): boolean {
	const label = basename(directory).toLowerCase();
	return label === "screenshots" || label === "screenshot" || label === "captures" || label === "capture";
}

function isScreenshotName(name: string): boolean {
	return SCREENSHOT_PATTERNS.some((pattern) => pattern.test(name));
}

function getScreenshotsFromDirectory(directory: string): ScreenshotInfo[] {
	if (!existsSync(directory)) {
		return [];
	}

	const allowAllImages = isDedicatedScreenshotDirectory(directory);

	return readdirSync(directory)
		.filter((name) => isImageFile(name) && (allowAllImages || isScreenshotName(name)))
		.map((name) => {
			const fullPath = join(directory, name);
			try {
				const stats = statSync(fullPath);
				return {
					path: fullPath,
					name,
					mtime: stats.mtime,
					size: stats.size,
				};
			} catch {
				return null;
			}
		})
		.filter((item): item is ScreenshotInfo => item !== null);
}

function getScreenshotsFromGlob(pattern: string, baseDir: string, homeDir = homedir()): ScreenshotInfo[] {
	const resolvedPattern = resolveSourcePath(pattern, baseDir, homeDir);
	try {
		const cwd = resolvedPattern.startsWith("/") ? "/" : baseDir;
		const glob = new Bun.Glob(resolvedPattern.startsWith("/") ? resolvedPattern.slice(1) : resolvedPattern);
		const paths = Array.from(glob.scanSync({ cwd, absolute: resolvedPattern.startsWith("/") }));
		return paths
			.filter((candidate) => {
				const lower = candidate.toLowerCase();
				return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp");
			})
			.map((candidate) => {
				const fullPath = resolve(candidate);
				try {
					const stats = statSync(fullPath);
					return {
						path: fullPath,
						name: basename(fullPath),
						mtime: stats.mtime,
						size: stats.size,
					};
				} catch {
					return null;
				}
			})
			.filter((item): item is ScreenshotInfo => item !== null);
	} catch {
		return [];
	}
}

function getScreenshotsFromSource(source: string, baseDir: string, homeDir = homedir()): ScreenshotInfo[] {
	const resolvedSource = resolveSourcePath(source, baseDir, homeDir);
	if (isGlobPattern(source) || isGlobPattern(resolvedSource)) {
		return getScreenshotsFromGlob(source, baseDir, homeDir);
	}
	return getScreenshotsFromDirectory(resolvedSource);
}

function createSourceLabel(source: string, homeDir = homedir()): string {
	const expanded = expandPath(source, homeDir);
	if (isGlobPattern(expanded)) {
		const prefix = expanded.split("*")[0] ?? expanded;
		const dir = dirname(prefix);
		return (basename(dir) || dir).slice(0, 15);
	}
	return basename(expanded).slice(0, 15);
}

function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const seconds = Math.floor(diffMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) {
		return days === 1 ? "yesterday" : `${days} days ago`;
	}
	if (hours > 0) {
		return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
	}
	if (minutes > 0) {
		return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
	}
	return "just now";
}

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function loadImageBase64(path: string): { data: string; mimeType: string } {
	const buffer = readFileSync(path);
	return {
		data: buffer.toString("base64"),
		mimeType: getMimeType(path),
	};
}

async function loadImageBase64Async(path: string): Promise<{ data: string; mimeType: string }> {
	const buffer = await readFile(path);
	return {
		data: buffer.toString("base64"),
		mimeType: getMimeType(path),
	};
}

function getMimeType(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
		return "image/jpeg";
	}
	if (lower.endsWith(".webp")) {
		return "image/webp";
	}
	return "image/png";
}

function createEmptyStagedState(): StagedImageState {
	return {
		images: [],
		paths: new Set<string>(),
	};
}

function consumeStagedInput(existingImages: ImageContent[] | undefined, state: StagedImageState): ConsumedStagedInput {
	const images = [...(existingImages ?? []), ...state.images];
	return {
		images,
		nextState: createEmptyStagedState(),
	};
}

function getSourceTabs(cwd: string, homeDir = homedir()): SourceTab[] {
	const config = loadPickerConfig(cwd, homeDir);
	const sources = resolveDefaultSources({
		configuredSources: config.sources ?? [],
		cwd,
		homeDir,
		env: Bun.env,
		platform: process.platform,
		exists: existsSync,
	});

	return sources.map((source) => {
		const screenshots = getScreenshotsFromSource(source, cwd, homeDir);
		screenshots.sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
		return {
			label: createSourceLabel(source, homeDir),
			pattern: source,
			screenshots,
		};
	});
}

function clearStagedState(state: StagedImageState): void {
	state.images = [];
	state.paths.clear();
}

function renderStagedStatusText(count: number): string {
	return `\x1b[30;47m Shots ${count} \x1b[0m`;
}

function updateStagedWidget(ctx: ExtensionContext, state: StagedImageState, options?: { suppress?: boolean }): void {
	if (options?.suppress) {
		return;
	}
	ctx.ui.setStatus(
		SCREENSHOTS_STATUS_KEY,
		state.images.length > 0 ? renderStagedStatusText(state.images.length) : undefined,
	);
}

function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId}\x1b\\`;
}

function getImageDimensions(base64Data: string, mimeType: string): { width: number; height: number } | null {
	const dimensions = getTerminalImageDimensions(base64Data, mimeType);
	if (!dimensions) {
		return null;
	}
	return {
		width: dimensions.widthPx,
		height: dimensions.heightPx,
	};
}

function calculateConstrainedWidth(
	dimensions: { width: number; height: number },
	maxRows: number,
	maxWidthCells: number,
): number {
	const cellDimensions = getCellDimensions();
	const safeMaxWidthCells = Math.max(1, maxWidthCells);
	const scaledWidthPx = safeMaxWidthCells * cellDimensions.widthPx;
	const scale = scaledWidthPx / dimensions.width;
	const scaledHeightPx = dimensions.height * scale;
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);

	if (rows <= maxRows) {
		return safeMaxWidthCells;
	}

	const targetHeightPx = maxRows * cellDimensions.heightPx;
	const targetScale = targetHeightPx / dimensions.height;
	const targetWidthPx = dimensions.width * targetScale;
	return Math.max(1, Math.min(safeMaxWidthCells, Math.floor(targetWidthPx / cellDimensions.widthPx)));
}

function padToWidth(content: string, targetWidth: number): string {
	const currentWidth = visibleWidth(content);
	if (currentWidth >= targetWidth) {
		return content;
	}
	return content + " ".repeat(targetWidth - currentWidth);
}

interface ZoomViewportGeometry {
	cropX: number;
	cropY: number;
	cropWidth: number;
	cropHeight: number;
	maxPanX: number;
	maxPanY: number;
	renderWidthCells: number;
	renderRows: number;
}

function encodeKittyWithCrop(
	base64Data: string,
	options: {
		columns: number;
		rows: number;
		imageId: number;
		cropX: number;
		cropY: number;
		cropWidth: number;
		cropHeight: number;
	},
): string {
	const chunkSize = 4096;
	const params = [
		"a=T",
		"f=100",
		"q=2",
		`c=${Math.max(1, Math.floor(options.columns))}`,
		`r=${Math.max(1, Math.floor(options.rows))}`,
		`i=${options.imageId}`,
		`x=${Math.max(0, Math.floor(options.cropX))}`,
		`y=${Math.max(0, Math.floor(options.cropY))}`,
		`w=${Math.max(1, Math.floor(options.cropWidth))}`,
		`h=${Math.max(1, Math.floor(options.cropHeight))}`,
	];

	if (base64Data.length <= chunkSize) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let firstChunk = true;
	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + chunkSize);
		const isLast = offset + chunkSize >= base64Data.length;
		if (firstChunk) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			firstChunk = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}
		offset += chunkSize;
	}

	return chunks.join("");
}

export default function screenshotsPickerExtension(pi: ExtensionAPI): void {
	const stagedState = createEmptyStagedState();
	let selectorOpen = false;

	function resetStaging(ctx?: ExtensionContext): void {
		clearStagedState(stagedState);
		if (ctx) {
			updateStagedWidget(ctx, stagedState);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		resetStaging(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		resetStaging(ctx);
	});
	pi.on("session_branch", async (_event, ctx) => {
		resetStaging(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		resetStaging(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (stagedState.images.length === 0) {
			return undefined;
		}

		const consumed = consumeStagedInput(event.images, stagedState);
		stagedState.images = consumed.nextState.images;
		stagedState.paths = consumed.nextState.paths;
		updateStagedWidget(ctx, stagedState);
		return {
			text: event.text,
			images: consumed.images,
		};
	});

	function toggleStagedScreenshot(screenshot: ScreenshotInfo): void {
		if (stagedState.paths.has(screenshot.path)) {
			const pathOrder = [...stagedState.paths];
			const index = pathOrder.indexOf(screenshot.path);
			if (index !== -1) {
				stagedState.images.splice(index, 1);
			}
			stagedState.paths.delete(screenshot.path);
			return;
		}

		try {
			const image = loadImageBase64(screenshot.path);
			stagedState.images.push({
				type: "image",
				mimeType: image.mimeType,
				data: image.data,
			});
			stagedState.paths.add(screenshot.path);
		} catch {
			// Ignore unreadable files.
		}
	}

	async function showScreenshotSelector(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Screenshot picker requires interactive UI", "warning");
			return;
		}

		const loadTabs = (): SourceTab[] => getSourceTabs(ctx.cwd).filter((tab) => tab.screenshots.length > 0);
		let tabs = loadTabs();
		if (tabs.length === 0) {
			ctx.ui.notify("No screenshots found in the configured or default sources", "warning");
			return;
		}

		const thumbnails = new Map<string, { data: string; mimeType: string } | null>();
		const thumbnailLoads = new Map<string, Promise<void>>();
		const imageDimensionsCache = new Map<string, { width: number; height: number } | null>();
		let requestPreviewRender: (() => void) | null = null;
		const supportsKittyInspector = TERMINAL.imageProtocol === ImageProtocol.Kitty;
		let result: string[] | null = null;

		function isThumbnailLoading(path: string): boolean {
			return thumbnailLoads.has(path);
		}

		function startThumbnailLoad(screenshot: ScreenshotInfo): void {
			if (thumbnails.has(screenshot.path) || thumbnailLoads.has(screenshot.path)) {
				return;
			}
			if (screenshot.size > MAX_THUMB_SIZE) {
				thumbnails.set(screenshot.path, null);
				return;
			}

			const loadPromise = loadImageBase64Async(screenshot.path)
				.then((image) => {
					thumbnails.set(screenshot.path, image);
					imageDimensionsCache.delete(screenshot.path);
				})
				.catch(() => {
					thumbnails.set(screenshot.path, null);
					imageDimensionsCache.delete(screenshot.path);
				})
				.finally(() => {
					thumbnailLoads.delete(screenshot.path);
					requestPreviewRender?.();
				});
			thumbnailLoads.set(screenshot.path, loadPromise);
		}

		function loadThumbnail(screenshot: ScreenshotInfo): { data: string; mimeType: string } | null {
			if (thumbnails.has(screenshot.path)) {
				return thumbnails.get(screenshot.path) ?? null;
			}
			if (screenshot.size > MAX_THUMB_SIZE) {
				thumbnails.set(screenshot.path, null);
				return null;
			}
			if (screenshot.size <= SYNC_THUMB_SIZE) {
				try {
					const image = loadImageBase64(screenshot.path);
					thumbnails.set(screenshot.path, image);
					return image;
				} catch {
					thumbnails.set(screenshot.path, null);
					return null;
				}
			}

			startThumbnailLoad(screenshot);
			return thumbnails.get(screenshot.path) ?? null;
		}

		function getScreenshotDimensions(screenshot: ScreenshotInfo): { width: number; height: number } | null {
			if (imageDimensionsCache.has(screenshot.path)) {
				return imageDimensionsCache.get(screenshot.path) ?? null;
			}

			const thumbnail = loadThumbnail(screenshot);
			if (!thumbnail) {
				if (thumbnails.has(screenshot.path) && !isThumbnailLoading(screenshot.path)) {
					imageDimensionsCache.set(screenshot.path, null);
				}
				return null;
			}

			const dimensions = getImageDimensions(thumbnail.data, thumbnail.mimeType);
			imageDimensionsCache.set(screenshot.path, dimensions);
			return dimensions;
		}

		function clamp(value: number, min: number, max: number): number {
			if (value < min) return min;
			if (value > max) return max;
			return value;
		}

		selectorOpen = true;
		try {
			result = await ctx.ui.custom<string[] | null>((tui, theme, _keybindings, done) => {
				const requestPickerRender = () => tui.requestRender(TERMINAL.imageProtocol === ImageProtocol.Kitty);
				requestPreviewRender = requestPickerRender;
				let activeTab = 0;
				let cursor = 0;
				let scrollOffset = 0;
				let previewZoom = false;
				let zoomLevel = 1;
				let panX = 0;
				let panY = 0;
				let lastRenderWidth = process.stdout.columns || 120;
				let lastRenderedKittyFrameKey = "";
				let deletePendingPath: string | null = null;

function clearRenderedKittyImage(): void {
	if (TERMINAL.imageProtocol === ImageProtocol.Kitty && lastRenderedKittyFrameKey) {
		process.stdout.write(deleteKittyImage(KITTY_IMAGE_ID));
	}
	lastRenderedKittyFrameKey = "";
}

				function buildTabsSignature(sourceTabs: SourceTab[]): string {
					return sourceTabs
						.map((tab) => `${tab.pattern}:${tab.screenshots.map((screenshot) => `${screenshot.path}:${screenshot.mtime.getTime()}`).join("|")}`)
						.join("||");
				}

				let tabsSignature = buildTabsSignature(tabs);

				function refreshTabsIfChanged(): boolean {
					const currentPattern = tabs[activeTab]?.pattern;
					const currentPath = getCurrentScreenshots()[cursor]?.path;
					const nextTabs = loadTabs();
					const nextSignature = buildTabsSignature(nextTabs);
					if (nextSignature === tabsSignature) {
						return false;
					}

					tabs = nextTabs;
					tabsSignature = nextSignature;
					if (tabs.length === 0) {
						clearRenderedKittyImage();
						done(null);
						return true;
					}

					const nextActiveTab = currentPattern ? tabs.findIndex((tab) => tab.pattern === currentPattern) : -1;
					activeTab = nextActiveTab === -1 ? Math.min(activeTab, tabs.length - 1) : nextActiveTab;

					const nextScreenshots = getCurrentScreenshots();
					if (nextScreenshots.length === 0) {
						cursor = 0;
						scrollOffset = 0;
						return true;
					}

					const nextCursor = currentPath ? nextScreenshots.findIndex((screenshot) => screenshot.path === currentPath) : -1;
					cursor = nextCursor === -1 ? Math.min(cursor, nextScreenshots.length - 1) : nextCursor;
					scrollOffset = Math.min(scrollOffset, Math.max(0, nextScreenshots.length - LIST_VISIBLE_ITEMS));
					clearPendingDelete();
					return true;
				}

				const refreshInterval = setInterval(() => {
					if (refreshTabsIfChanged()) {
						requestPickerRender();
					}
				}, SCREENSHOT_REFRESH_INTERVAL_MS);

				function getCurrentScreenshots(): ScreenshotInfo[] {
					return tabs[activeTab]?.screenshots ?? [];
				}

				function warmThumbnailsAroundCursor(distance = 5): void {
					const screenshots = getCurrentScreenshots();
					if (screenshots.length === 0) {
						return;
					}
					const start = Math.max(0, cursor - distance);
					const end = Math.min(screenshots.length - 1, cursor + distance);
					for (let index = start; index <= end; index++) {
						const screenshot = screenshots[index];
						if (screenshot) {
							loadThumbnail(screenshot);
						}
					}
				}

				function resetZoomViewport(): void {
					zoomLevel = 1;
					panX = 0;
					panY = 0;
				}

				function clearPendingDelete(): void {
					deletePendingPath = null;
				}

				function moveCursor(delta: number): boolean {
					const screenshots = getCurrentScreenshots();
					if (screenshots.length === 0) {
						return false;
					}

					const nextCursor = clamp(cursor + delta, 0, screenshots.length - 1);
					if (nextCursor === cursor) {
						return false;
					}

					cursor = nextCursor;
					if (cursor < scrollOffset) {
						scrollOffset = cursor;
					}
					if (cursor >= scrollOffset + LIST_VISIBLE_ITEMS) {
						scrollOffset = cursor - LIST_VISIBLE_ITEMS + 1;
					}
					resetZoomViewport();
					clearPendingDelete();
					return true;
				}

				function clearAllStaged(): void {
					clearStagedState(stagedState);
				}

				function getZoomPreviewLines(): number {
					const terminalRows = process.stdout.rows || 40;
					const availableRows = Math.max(PREVIEW_LINES, terminalRows - 14);
					return Math.max(ZOOM_PREVIEW_MIN_LINES, Math.min(ZOOM_PREVIEW_MAX_LINES, availableRows));
				}

				function getMaxPreviewWidthCells(width: number, isZoomMode: boolean): number {
					const listWidth = isZoomMode ? 0 : LIST_WIDTH;
					const widthCap = isZoomMode ? ZOOM_PREVIEW_WIDTH_CAP : PREVIEW_WIDTH_CAP;
					return Math.max(1, Math.min(widthCap, width - listWidth - (isZoomMode ? 2 : 3)));
				}

				function calculateKittyFit(
					dimensions: { width: number; height: number },
					maxPreviewWidthCells: number,
					previewLines: number,
				): { columns: number; rows: number } {
					const columns = calculateConstrainedWidth(dimensions, previewLines, maxPreviewWidthCells);
					const cellDimensions = getCellDimensions();
					const rows = Math.max(
						1,
						Math.min(previewLines, calculateImageRows({ widthPx: dimensions.width, heightPx: dimensions.height }, columns, cellDimensions)),
					);
					return { columns, rows };
				}

				function getZoomViewportGeometry(
					screenshot: ScreenshotInfo,
					maxPreviewWidthCells: number,
					previewLines: number,
				): ZoomViewportGeometry | null {
					const dimensions = getScreenshotDimensions(screenshot);
					if (!dimensions) {
						return null;
					}

					const cellDimensions = getCellDimensions();
					const viewportWidthPx = Math.max(1, maxPreviewWidthCells * cellDimensions.widthPx);
					const viewportHeightPx = Math.max(1, previewLines * cellDimensions.heightPx);
					const fitScale = Math.min(viewportWidthPx / dimensions.width, viewportHeightPx / dimensions.height);
					const safeFitScale = fitScale > 0 && Number.isFinite(fitScale) ? fitScale : 1;
					const scale = safeFitScale * zoomLevel;

					const cropWidth = Math.max(1, Math.min(dimensions.width, Math.floor(viewportWidthPx / scale)));
					const cropHeight = Math.max(1, Math.min(dimensions.height, Math.floor(viewportHeightPx / scale)));
					const maxPanX = Math.max(0, dimensions.width - cropWidth);
					const maxPanY = Math.max(0, dimensions.height - cropHeight);
					panX = clamp(panX, 0, maxPanX);
					panY = clamp(panY, 0, maxPanY);

					const renderWidthPx = cropWidth * scale;
					const renderHeightPx = cropHeight * scale;
					const renderWidthCells = Math.max(1, Math.min(maxPreviewWidthCells, Math.floor(renderWidthPx / cellDimensions.widthPx)));
					const renderRows = Math.max(1, Math.min(previewLines, Math.ceil(renderHeightPx / cellDimensions.heightPx)));

					return {
						cropX: Math.round(panX),
						cropY: Math.round(panY),
						cropWidth,
						cropHeight,
						maxPanX,
						maxPanY,
						renderWidthCells,
						renderRows,
					};
				}

				function panViewport(horizontal: number, vertical: number): boolean {
					if (!previewZoom || !supportsKittyInspector) {
						return false;
					}
					const currentScreenshot = getCurrentScreenshots()[cursor];
					if (!currentScreenshot) {
						return false;
					}

					const previewLines = getZoomPreviewLines();
					const maxPreviewWidthCells = getMaxPreviewWidthCells(lastRenderWidth, true);
					const geometry = getZoomViewportGeometry(currentScreenshot, maxPreviewWidthCells, previewLines);
					if (!geometry) {
						return false;
					}

					const stepX = Math.max(12, Math.floor(geometry.cropWidth * ZOOM_PAN_STEP_RATIO));
					const stepY = Math.max(12, Math.floor(geometry.cropHeight * ZOOM_PAN_STEP_RATIO));
					const nextPanX = clamp(panX + horizontal * stepX, 0, geometry.maxPanX);
					const nextPanY = clamp(panY + vertical * stepY, 0, geometry.maxPanY);
					if (nextPanX === panX && nextPanY === panY) {
						return false;
					}

					panX = nextPanX;
					panY = nextPanY;
					return true;
				}

				function setZoomLevel(nextZoomLevel: number): boolean {
					const clampedZoom = clamp(nextZoomLevel, ZOOM_LEVEL_MIN, ZOOM_LEVEL_MAX);
					if (clampedZoom === zoomLevel) {
						return false;
					}
					zoomLevel = clampedZoom;
					const currentScreenshot = getCurrentScreenshots()[cursor];
					if (!currentScreenshot) {
						panX = 0;
						panY = 0;
						return true;
					}

					const previewLines = getZoomPreviewLines();
					const maxPreviewWidthCells = getMaxPreviewWidthCells(lastRenderWidth, true);
					const geometry = getZoomViewportGeometry(currentScreenshot, maxPreviewWidthCells, previewLines);
					if (!geometry) {
						panX = 0;
						panY = 0;
					}
					return true;
				}

				function renderKittyThumbnail(
					screenshot: ScreenshotInfo,
					maxPreviewWidthCells: number,
					previewLines: number,
				): string[] {
					const thumbnail = loadThumbnail(screenshot);
					const name = screenshot.name.slice(-20);
					const frameKey = `${screenshot.path}:${maxPreviewWidthCells}:${previewLines}`;
					const deletePrefix = lastRenderedKittyFrameKey && lastRenderedKittyFrameKey !== frameKey ? deleteKittyImage(KITTY_IMAGE_ID) : "";
					lastRenderedKittyFrameKey = frameKey;

					if (!thumbnail) {
						const loading = isThumbnailLoading(screenshot.path);
						const lines = [deletePrefix + theme.fg("dim", loading ? `  [Loading preview: ${name}]` : `  [No preview: ${name}]`)];
						while (lines.length < previewLines) {
							lines.push("");
						}
						return lines;
					}

					const dimensions = getScreenshotDimensions(screenshot);
					if (!dimensions) {
						const lines = [deletePrefix + theme.fg("dim", `  [No preview: ${name}]`)];
						while (lines.length < previewLines) {
							lines.push("");
						}
						return lines;
					}

					const fit = calculateKittyFit(dimensions, maxPreviewWidthCells, previewLines);
					const sequence = encodeKitty(thumbnail.data, {
						columns: fit.columns,
						rows: fit.rows,
						imageId: KITTY_IMAGE_ID,
					});
					const moveUp = fit.rows > 1 ? `\x1b[${fit.rows - 1}A` : "";
					const lines: string[] = [];
					for (let index = 0; index < fit.rows - 1; index++) {
						lines.push("");
					}
					lines.push(deletePrefix + moveUp + sequence);
					while (lines.length < previewLines) {
						lines.push("");
					}
					return lines;
				}

				function renderStandardThumbnail(
					screenshot: ScreenshotInfo,
					maxPreviewWidthCells: number,
					previewLines: number,
				): string[] {
					if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
						return renderKittyThumbnail(screenshot, maxPreviewWidthCells, previewLines);
					}

					const thumbnail = loadThumbnail(screenshot);
					const name = screenshot.name.slice(-20);
					if (!thumbnail) {
						const loading = isThumbnailLoading(screenshot.path);
						const lines = [theme.fg("dim", loading ? `  [Loading preview: ${name}]` : `  [No preview: ${name}]`)];
						while (lines.length < previewLines) {
							lines.push("");
						}
						return lines;
					}

					const dimensions = getScreenshotDimensions(screenshot);
					const maxWidth = dimensions ? calculateConstrainedWidth(dimensions, previewLines, maxPreviewWidthCells) : maxPreviewWidthCells;
					const image = new Image(
						thumbnail.data,
						thumbnail.mimeType,
						{ fallbackColor: (value: string) => theme.fg("dim", value) },
						{ maxWidthCells: maxWidth, maxHeightCells: previewLines, filename: screenshot.name },
					);
					const rendered = image.render(maxWidth + 2);
					const lines = rendered.slice(0, previewLines);
					while (lines.length < previewLines) {
						lines.push("");
					}
					return lines;
				}

				function renderZoomInspectorThumbnail(
					screenshot: ScreenshotInfo,
					maxPreviewWidthCells: number,
					previewLines: number,
				): { lines: string[]; geometry: ZoomViewportGeometry | null } {
					if (!supportsKittyInspector) {
						const zoomedWidth = Math.max(1, Math.min(ZOOM_PREVIEW_WIDTH_CAP, Math.floor(maxPreviewWidthCells * zoomLevel)));
						return {
							lines: renderStandardThumbnail(screenshot, zoomedWidth, previewLines),
							geometry: null,
						};
					}

					const thumbnail = loadThumbnail(screenshot);
					const name = screenshot.name.slice(-20);
					const deletePrefix = lastRenderedKittyFrameKey ? deleteKittyImage(KITTY_IMAGE_ID) : "";
					lastRenderedKittyFrameKey = `${screenshot.path}:${maxPreviewWidthCells}:${previewLines}:zoom`;
					if (!thumbnail) {
						const loading = isThumbnailLoading(screenshot.path);
						const lines = [deletePrefix + theme.fg("dim", loading ? `  [Loading preview: ${name}]` : `  [No preview: ${name}]`)];
						while (lines.length < previewLines) {
							lines.push("");
						}
						return { lines, geometry: null };
					}

					const geometry = getZoomViewportGeometry(screenshot, maxPreviewWidthCells, previewLines);
					if (!geometry) {
						const lines = [deletePrefix + theme.fg("dim", `  [No inspect preview: ${name}]`)];
						while (lines.length < previewLines) {
							lines.push("");
						}
						return { lines, geometry: null };
					}

					const sequence = encodeKittyWithCrop(thumbnail.data, {
						columns: geometry.renderWidthCells,
						rows: geometry.renderRows,
						imageId: KITTY_IMAGE_ID,
						cropX: geometry.cropX,
						cropY: geometry.cropY,
						cropWidth: geometry.cropWidth,
						cropHeight: geometry.cropHeight,
					});
					const moveUp = geometry.renderRows > 1 ? `\x1b[${geometry.renderRows - 1}A` : "";
					const lines: string[] = [];
					for (let index = 0; index < geometry.renderRows - 1; index++) {
						lines.push("");
					}
					lines.push(deletePrefix + moveUp + sequence);
					while (lines.length < previewLines) {
						lines.push("");
					}
					return { lines, geometry };
				}

				function removeScreenshotFromCurrentTab(targetPath: string): boolean {
					const screenshots = tabs[activeTab]?.screenshots ?? [];
					const index = screenshots.findIndex((entry) => entry.path === targetPath);
					if (index === -1) {
						return false;
					}
					screenshots.splice(index, 1);
					if (stagedState.paths.has(targetPath)) {
						const pathOrder = [...stagedState.paths];
						const stagedIndex = pathOrder.indexOf(targetPath);
						if (stagedIndex !== -1) {
							stagedState.images.splice(stagedIndex, 1);
						}
						stagedState.paths.delete(targetPath);
					}
					thumbnails.delete(targetPath);
					imageDimensionsCache.delete(targetPath);
					clearPendingDelete();
					if (screenshots.length === 0) {
						const nextTab = tabs.findIndex((tab, index) => index !== activeTab && tab.screenshots.length > 0);
						if (nextTab !== -1) {
							activeTab = nextTab;
							cursor = 0;
							scrollOffset = 0;
							resetZoomViewport();
							return true;
						}
						clearRenderedKittyImage();
						done(null);
						return true;
					}

					if (cursor >= screenshots.length) {
						cursor = screenshots.length - 1;
					}
					if (scrollOffset > 0 && scrollOffset >= screenshots.length - LIST_VISIBLE_ITEMS + 1) {
						scrollOffset = Math.max(0, screenshots.length - LIST_VISIBLE_ITEMS);
					}
					resetZoomViewport();
					return true;
				}

				return {
					render(width: number) {
						lastRenderWidth = width;
						const lines: string[] = [];
						const border = theme.fg("accent", "─".repeat(width));
						const screenshots = getCurrentScreenshots();
						warmThumbnailsAroundCursor();
						const previewLines = previewZoom ? getZoomPreviewLines() : PREVIEW_LINES;
						const listVisibleItems = previewZoom ? 0 : LIST_VISIBLE_ITEMS;
						const contentRows = Math.max(listVisibleItems, previewLines);
						const maxPreviewWidthCells = getMaxPreviewWidthCells(width, previewZoom);

						lines.push(border);
						if (tabs.length > 1) {
							let tabLine = " ";
							for (let index = 0; index < tabs.length; index++) {
								const tab = tabs[index];
								const count = tab.screenshots.length;
								const label = `${tab.label} (${count})`;
								tabLine += index === activeTab ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("dim", ` ${label} `);
								tabLine += " ";
							}
							tabLine += theme.fg("dim", previewZoom ? "  Ctrl+T switch • z split" : "  Ctrl+T switch • z zoom");
							if (previewZoom) {
								lines.push(tabLine);
								lines.push("");
							} else {
								lines.push(padToWidth(tabLine, LIST_WIDTH) + "│");
								lines.push(padToWidth("", LIST_WIDTH) + "│");
							}
						}

						if (previewZoom) {
							const countInfo = screenshots.length > 0 ? ` (${cursor + 1}/${screenshots.length})` : "";
							lines.push(" " + theme.fg("accent", theme.bold("Screenshot Inspector")) + theme.fg("dim", countInfo));
							lines.push(" " + theme.fg("dim", expandPath(tabs[activeTab]?.pattern ?? "").slice(-80)));
							const currentScreenshot = screenshots[cursor];
							const zoomRender = currentScreenshot
								? renderZoomInspectorThumbnail(currentScreenshot, maxPreviewWidthCells, previewLines)
								: { lines: Array(previewLines).fill(""), geometry: null as ZoomViewportGeometry | null };
							if (currentScreenshot) {
								const panInfo = zoomRender.geometry
									? ` • pan ${Math.round(panX)}/${zoomRender.geometry.maxPanX}, ${Math.round(panY)}/${zoomRender.geometry.maxPanY}`
									: "";
								lines.push(
									" " +
										theme.fg(
											"dim",
											`${currentScreenshot.name} • ${formatRelativeTime(currentScreenshot.mtime)} • ${formatSize(currentScreenshot.size)} • zoom ${zoomLevel.toFixed(2)}x${panInfo}`,
										),
								);
								if (!supportsKittyInspector) {
									lines.push(" " + theme.fg("dim", "Pan inspection requires Kitty-compatible image protocol"));
								}
							} else {
								lines.push(" " + theme.fg("dim", "No screenshot selected"));
							}
							lines.push("");
							for (let index = 0; index < contentRows; index++) {
								lines.push(" " + (zoomRender.lines[index] ?? ""));
							}
						} else {
							const countInfo = screenshots.length > LIST_VISIBLE_ITEMS ? ` (${cursor + 1}/${screenshots.length})` : "";
							lines.push(padToWidth(" " + theme.fg("accent", theme.bold("Recent Screenshots")) + theme.fg("dim", countInfo), LIST_WIDTH) + "│");
							lines.push(padToWidth(" " + theme.fg("dim", expandPath(tabs[activeTab]?.pattern ?? "").slice(-40)), LIST_WIDTH) + "│");
							lines.push(padToWidth("", LIST_WIDTH) + "│");
							const currentScreenshot = screenshots[cursor];
							const imageLines = currentScreenshot ? renderStandardThumbnail(currentScreenshot, maxPreviewWidthCells, previewLines) : Array(previewLines).fill("");
							for (let index = 0; index < contentRows; index++) {
								let listLine = "";
								if (index < listVisibleItems) {
									const itemIndex = scrollOffset + index;
									const screenshot = screenshots[itemIndex];
									if (screenshot) {
										const isStaged = stagedState.paths.has(screenshot.path);
										const isCursor = itemIndex === cursor;
										const cursorIndicator = isCursor ? "▸" : " ";
										const checkbox = isStaged ? "✓" : "○";
										const timeStr = screenshot.mtime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
										listLine = ` ${cursorIndicator} ${checkbox} ${timeStr} (${formatRelativeTime(screenshot.mtime)}) - ${formatSize(screenshot.size)}`;
										if (isStaged) {
											listLine = theme.fg("success", listLine);
										} else if (isCursor) {
											listLine = theme.fg("accent", listLine);
										} else {
											listLine = theme.fg("text", listLine);
										}
									}
								}
								lines.push(padToWidth(listLine, LIST_WIDTH) + "│ " + (imageLines[index] ?? ""));
							}
						}

						lines.push("");
						const stagedCount = stagedState.images.length;
						const zoomSelectionLocked = previewZoom && supportsKittyInspector && zoomLevel > ZOOM_LEVEL_MIN;
						if (deletePendingPath) {
							lines.push(" " + theme.fg("warning", "Press d again to delete this screenshot from disk"));
							lines.push(" " + theme.fg("dim", "Any other key cancels deletion"));
						} else if (stagedCount === 0) {
							lines.push(" " + theme.fg("warning", "Press s or space to stage screenshots before closing"));
							if (zoomSelectionLocked) {
								lines.push(" " + theme.fg("warning", "Zoom lock active: press 0 before using up or down to switch screenshots"));
							}
							lines.push(
								" " +
									theme.fg(
										"dim",
										previewZoom
											? supportsKittyInspector
												? "↑↓←→ pan • +/- zoom • [ ] nav • 0 reset • z split • s toggle • enter done"
												: "↑↓ nav • +/- zoom • z split • s toggle • enter done"
											: "↑↓ nav • z zoom • s toggle • o open • d delete • enter done",
									),
							);
						} else {
							lines.push(" " + theme.fg("success", `${stagedCount} staged`));
							if (zoomSelectionLocked) {
								lines.push(" " + theme.fg("warning", "Zoom lock active: press 0 before using up or down to switch screenshots"));
							}
							lines.push(
								" " +
									theme.fg(
										"dim",
										previewZoom
											? supportsKittyInspector
												? "↑↓←→ pan • +/- zoom • [ ] nav • 0 reset • z split • x clear • enter done"
												: "↑↓ nav • +/- zoom • z split • x clear • enter done"
											: "z zoom • s toggle • x clear • d delete • enter done",
									),
							);
						}
						lines.push(border);
						return lines;
					},
					invalidate() {},
					handleInput(data: string) {
						const screenshots = getCurrentScreenshots();
						const currentScreenshot = screenshots[cursor];

						if (deletePendingPath) {
							if ((data === "d" || data === "D") && currentScreenshot && currentScreenshot.path === deletePendingPath) {
								try {
									unlinkSync(deletePendingPath);
									removeScreenshotFromCurrentTab(deletePendingPath);
									updateStagedWidget(ctx, stagedState, { suppress: selectorOpen });
									requestPickerRender();
								} catch {
									clearPendingDelete();
									requestPickerRender();
								}
								return;
							}
							clearPendingDelete();
							requestPickerRender();
							return;
						}

						if (matchesKey(data, "ctrl+shift+s")) {
							return;
						}
						if (matchesKey(data, "ctrl+shift+x")) {
							clearAllStaged();
							updateStagedWidget(ctx, stagedState, { suppress: selectorOpen });
							requestPickerRender();
							return;
						}
						if (matchesKey(data, "ctrl+t")) {
							if (tabs.length > 1) {
								activeTab = (activeTab + 1) % tabs.length;
								cursor = 0;
								scrollOffset = 0;
								resetZoomViewport();
								clearPendingDelete();
								requestPickerRender();
							}
							return;
						}
						if (data === "z" || data === "Z") {
							previewZoom = !previewZoom;
							resetZoomViewport();
							clearPendingDelete();
							requestPickerRender();
							return;
						}

						if (previewZoom) {
							if (data === "+" || data === "=") {
								if (setZoomLevel(zoomLevel + ZOOM_LEVEL_STEP)) {
									requestPickerRender();
								}
								return;
							}
							if (data === "-" || data === "_") {
								if (setZoomLevel(zoomLevel - ZOOM_LEVEL_STEP)) {
									requestPickerRender();
								}
								return;
							}
							if (data === "0") {
								if (zoomLevel !== 1 || panX !== 0 || panY !== 0) {
									resetZoomViewport();
									requestPickerRender();
								}
								return;
							}
							if (data === "[" || data === "{") {
								if (moveCursor(-1)) {
									requestPickerRender();
								}
								return;
							}
							if (data === "]" || data === "}") {
								if (moveCursor(1)) {
									requestPickerRender();
								}
								return;
							}
							if (matchesKey(data, "left")) {
								if (panViewport(-1, 0)) {
									requestPickerRender();
								}
								return;
							}
							if (matchesKey(data, "right")) {
								if (panViewport(1, 0)) {
									requestPickerRender();
								}
								return;
							}
							if (matchesKey(data, "up")) {
								if (panViewport(0, -1)) {
									requestPickerRender();
									return;
								}
								if (supportsKittyInspector && zoomLevel > ZOOM_LEVEL_MIN) {
									return;
								}
								if (moveCursor(-1)) {
									requestPickerRender();
								}
								return;
							}
							if (matchesKey(data, "down")) {
								if (panViewport(0, 1)) {
									requestPickerRender();
									return;
								}
								if (supportsKittyInspector && zoomLevel > ZOOM_LEVEL_MIN) {
									return;
								}
								if (moveCursor(1)) {
									requestPickerRender();
								}
								return;
							}
						}

						if (matchesKey(data, "up")) {
							if (moveCursor(-1)) {
								requestPickerRender();
							}
							return;
						}
						if (matchesKey(data, "down")) {
							if (moveCursor(1)) {
								requestPickerRender();
							}
							return;
						}
						if (matchesKey(data, "space") || data === "s" || data === "S") {
							if (currentScreenshot) {
								toggleStagedScreenshot(currentScreenshot);
								updateStagedWidget(ctx, stagedState, { suppress: selectorOpen });
								clearPendingDelete();
								requestPickerRender();
							}
							return;
						}
						if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
							clearRenderedKittyImage();
							done([]);
							return;
						}
						if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
							clearRenderedKittyImage();
							done(null);
							return;
						}
						if ((data === "o" || data === "O") && currentScreenshot) {
							try {
								if (process.platform === "darwin") {
									execSync(`open \"${currentScreenshot.path}\"`);
								} else if (process.platform === "linux") {
									execSync(`xdg-open \"${currentScreenshot.path}\" &`);
								}
							} catch {
								// Ignore open failures.
							}
							return;
						}
						if ((data === "x" || data === "X") && stagedState.images.length > 0) {
							clearAllStaged();
							updateStagedWidget(ctx, stagedState, { suppress: selectorOpen });
							clearPendingDelete();
							requestPickerRender();
							return;
						}
						if ((data === "d" || data === "D") && currentScreenshot) {
							deletePendingPath = currentScreenshot.path;
							requestPickerRender();
						}
					},
					dispose() {
						clearInterval(refreshInterval);
						clearRenderedKittyImage();
					},
				};
			}, { overlay: true });
		} finally {
			selectorOpen = false;
			requestPreviewRender = null;
		}

		if (result === null) {
			return;
		}

		if (stagedState.images.length > 0) {
			const count = stagedState.images.length;
			const label = count === 1 ? "screenshot" : "screenshots";
			ctx.ui.notify(`${count} ${label} staged. Type your message and send.`, "info");
		}
	}

	pi.registerCommand("ss", {
		description: "Show recent screenshots for quick attachment",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText("");
			await showScreenshotSelector(ctx);
			updateStagedWidget(ctx, stagedState);
		},
	});

	pi.registerCommand("ss-clear", {
		description: "Clear staged screenshots",
		handler: async (_args, ctx) => {
			const count = stagedState.images.length;
			resetStaging(ctx);
			ctx.ui.notify(count > 0 ? `Cleared ${count} staged screenshot${count === 1 ? "" : "s"}` : "No staged screenshots to clear", "info");
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Show recent screenshots",
		handler: async (ctx) => {
			await showScreenshotSelector(ctx);
			updateStagedWidget(ctx, stagedState);
		},
	});

	pi.registerShortcut("ctrl+shift+x", {
		description: "Clear staged screenshots",
		handler: async (ctx) => {
			const count = stagedState.images.length;
			resetStaging(ctx);
			if (count > 0) {
				ctx.ui.notify(`Cleared ${count} staged screenshot${count === 1 ? "" : "s"}`, "info");
			}
		},
	});
}

export const _testExports = {
	consumeStagedInput,
	getScreenshotsFromSource,
	renderStagedStatusText,
	resolveDefaultSources,
	screenshotsStatusKey: SCREENSHOTS_STATUS_KEY,
};
