import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { SingleResult } from "../../task/types";
import { getDirectUsageTokens } from "../../utils/usage-tokens";
import { extractAssignmentPreview, extractTaskContextPreview } from "./task-preview";
import type { SubagentIndexSnapshot, SubagentStatus, SubagentViewGroup, SubagentViewRef } from "./types";

interface SubagentIndexOptions {
	artifactsDir?: string;
}

type FilesystemRef = {
	id: string;
	sessionPath: string;
	outputPath?: string;
	mtimeMs: number;
	lastSeenOrder: number;
	sourcePath: string;
};

type ScanArtifactsResult = {
	entries: Map<string, FilesystemRef>;
	artifactsRoot?: string;
};

export class SubagentIndex {
	#artifactsDir?: string;
	#artifactsRootRealpath?: string;
	#snapshot: SubagentIndexSnapshot = {
		version: 0,
		updatedAt: 0,
		refs: [],
		groups: [],
	};
	#taskRefs = new Map<string, SubagentViewRef>();
	#filesystemRefs = new Map<string, FilesystemRef>();
	#seenOrder = 0;
	#reconcileToken = 0;

	constructor(options: SubagentIndexOptions) {
		this.#artifactsDir = options.artifactsDir;
	}

	getSnapshot(): SubagentIndexSnapshot {
		return this.#snapshot;
	}

	ingestTaskResults(results: ReadonlyArray<SingleResult> | unknown): SubagentIndexSnapshot {
		if (!Array.isArray(results)) {
			return this.#snapshot;
		}

		for (const result of results) {
			this.#ingestTaskResult(result);
		}

		return this.#rebuildSnapshot();
	}

	async reconcile(): Promise<SubagentIndexSnapshot> {
		const token = ++this.#reconcileToken;
		const { entries, artifactsRoot } = await this.scanArtifacts();
		if (token !== this.#reconcileToken) {
			return this.#snapshot;
		}

		this.#filesystemRefs = entries;
		this.#artifactsRootRealpath = artifactsRoot;
		return this.#rebuildSnapshot();
	}

	async resolveSafePaths(refId: string): Promise<{ sessionPath?: string; outputPath?: string }> {
		const ref = this.#snapshot.refs.find(candidate => candidate.id === refId);
		if (!ref) {
			return {};
		}

		const artifactsRoot = await this.#resolveArtifactsRootRealpath();
		if (!artifactsRoot) {
			return {};
		}

		const sessionPath = await this.#resolveContainedPath(ref.sessionPath, artifactsRoot, "sessionPath", ref.id);
		const outputPath = await this.#resolveContainedPath(ref.outputPath, artifactsRoot, "outputPath", ref.id);

		return { sessionPath, outputPath };
	}

	protected async scanArtifacts(): Promise<ScanArtifactsResult> {
		const entries = new Map<string, FilesystemRef>();
		const artifactsRoot = await this.#resolveArtifactsRootRealpath();
		if (!artifactsRoot) {
			return { entries };
		}

		await this.#walkArtifactsTree(artifactsRoot, entries);
		return { entries, artifactsRoot };
	}

	async #walkArtifactsTree(currentDir: string, entries: Map<string, FilesystemRef>): Promise<void> {
		let dirEntries: Dirent[] = [];
		try {
			dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
		} catch (error: unknown) {
			if (!isEnoent(error)) {
				logger.warn("Failed to read subagent artifacts directory", {
					path: currentDir,
					error: String(error),
				});
			}
			return;
		}

		dirEntries.sort((left, right) => left.name.localeCompare(right.name));
		for (const dirent of dirEntries) {
			const absolutePath = path.join(currentDir, dirent.name);
			if (dirent.isDirectory()) {
				await this.#walkArtifactsTree(absolutePath, entries);
				continue;
			}
			if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) {
				continue;
			}

			const id = path.basename(dirent.name, ".jsonl").trim();
			if (!id) {
				continue;
			}

			let mtimeMs = 0;
			try {
				const stats = await fs.stat(absolutePath);
				mtimeMs = stats.mtimeMs;
			} catch (error: unknown) {
				if (!isEnoent(error)) {
					logger.warn("Failed to stat subagent artifact", {
						path: absolutePath,
						error: String(error),
					});
				}
				continue;
			}

			this.#seenOrder += 1;
			const candidate: FilesystemRef = {
				id,
				sessionPath: absolutePath,
				outputPath: `${absolutePath.slice(0, -6)}.md`,
				mtimeMs,
				lastSeenOrder: this.#seenOrder,
				sourcePath: absolutePath,
			};
			this.#upsertFilesystemRef(entries, candidate);
		}
	}

	#upsertFilesystemRef(entries: Map<string, FilesystemRef>, candidate: FilesystemRef): void {
		const existing = entries.get(candidate.id);
		if (!existing) {
			entries.set(candidate.id, candidate);
			return;
		}

		const winner = this.#pickFilesystemWinner(existing, candidate);
		if (existing.sourcePath !== candidate.sourcePath) {
			logger.warn("Detected duplicate subagent transcript id during bootstrap", {
				id: candidate.id,
				keptPath: winner.sourcePath,
				discardedPath: winner === existing ? candidate.sourcePath : existing.sourcePath,
			});
		}

		entries.set(candidate.id, winner);
	}

	#pickFilesystemWinner(left: FilesystemRef, right: FilesystemRef): FilesystemRef {
		if (left.mtimeMs !== right.mtimeMs) {
			return left.mtimeMs > right.mtimeMs ? left : right;
		}
		return left.sourcePath.localeCompare(right.sourcePath) <= 0 ? left : right;
	}

	#ingestTaskResult(result: unknown): void {
		if (!result || typeof result !== "object") {
			return;
		}

		const record = result as Record<string, unknown>;
		const id = this.#readString(record.id)?.trim();
		if (!id) {
			return;
		}

		const existing = this.#taskRefs.get(id) ?? this.#createBaseRef(id);
		this.#seenOrder += 1;

		const outputPath = this.#readString(record.outputPath);
		const sessionPath =
			this.#readString(record.sessionPath) ??
			(outputPath?.endsWith(".md") ? `${outputPath.slice(0, -3)}.jsonl` : undefined);

		if (outputPath) existing.outputPath = outputPath;
		if (sessionPath) existing.sessionPath = sessionPath;
		if (!existing.outputPath && existing.sessionPath?.endsWith(".jsonl")) {
			existing.outputPath = `${existing.sessionPath.slice(0, -6)}.md`;
		}
		if (!existing.sessionPath && existing.outputPath?.endsWith(".md")) {
			existing.sessionPath = `${existing.outputPath.slice(0, -3)}.jsonl`;
		}
		if (!existing.outputPath && this.#artifactsDir) {
			existing.outputPath = path.join(this.#artifactsDir, `${id}.md`);
		}
		if (!existing.sessionPath && this.#artifactsDir) {
			existing.sessionPath = path.join(this.#artifactsDir, `${id}.jsonl`);
		}

		const agent = this.#readString(record.agent);
		if (agent) existing.agent = agent;
		const description = this.#readString(record.description);
		if (description) existing.description = description;
		const model = this.#formatSubagentModel(record.modelOverride);
		if (model) existing.model = model;

		const usageTokens = getDirectUsageTokens(record.usage);
		const explicitTokens = this.#readNumber(record.tokens);
		if (explicitTokens !== undefined || usageTokens !== undefined) {
			existing.tokens = usageTokens ?? explicitTokens;
		}

		const task = this.#readString(record.task) ?? "";
		const contextPreview = extractTaskContextPreview(task);
		if (contextPreview) existing.contextPreview = contextPreview;
		const assignmentPreview = extractAssignmentPreview(task);
		if (assignmentPreview) existing.assignmentPreview = assignmentPreview;

		const status = this.#parseSubagentStatus(record.status) ?? this.#inferStatusFromTaskResult(record);
		if (status) {
			existing.status = status;
		}

		const thinkingLevel = this.#readString(record.thinkingLevel);
		if (thinkingLevel) existing.thinkingLevel = thinkingLevel;
		const tokenCapacity =
			this.#readNumber(record.tokenCapacity) ??
			this.#readNumber(record.contextWindow) ??
			this.#readNumber(record.maxTokens);
		if (tokenCapacity !== undefined) existing.tokenCapacity = tokenCapacity;
		const startedAt = this.#parseTimestamp(record.startedAt);
		if (startedAt !== undefined) existing.startedAt = startedAt;
		const elapsedMs = this.#readNumber(record.elapsedMs) ?? this.#readNumber(record.durationMs);
		if (elapsedMs !== undefined) existing.elapsedMs = elapsedMs;
		const sessionId = this.#readString(record.sessionId);
		if (sessionId) existing.sessionId = sessionId;
		const parentAgentName = this.#readString(record.parentAgentName) ?? this.#readString(record.parentAgent);
		if (parentAgentName) existing.parentAgentName = parentAgentName;

		const lastUpdatedMs =
			this.#readNumber(record.lastUpdatedMs) ??
			(existing.startedAt !== undefined && existing.elapsedMs !== undefined
				? existing.startedAt + existing.elapsedMs
				: undefined);
		if (lastUpdatedMs !== undefined) {
			existing.lastUpdatedMs = Math.max(existing.lastUpdatedMs ?? 0, lastUpdatedMs);
		}
		existing.lastSeenOrder = this.#seenOrder;

		this.#taskRefs.set(id, existing);
	}

	#rebuildSnapshot(): SubagentIndexSnapshot {
		const merged = new Map<string, SubagentViewRef>();

		for (const filesystemRef of this.#filesystemRefs.values()) {
			const next = merged.get(filesystemRef.id) ?? this.#createBaseRef(filesystemRef.id);
			next.sessionPath ??= filesystemRef.sessionPath;
			next.outputPath ??= filesystemRef.outputPath;
			next.lastUpdatedMs = Math.max(next.lastUpdatedMs ?? 0, filesystemRef.mtimeMs);
			next.lastSeenOrder = Math.max(next.lastSeenOrder ?? 0, filesystemRef.lastSeenOrder);
			next.status ??= "completed";
			merged.set(filesystemRef.id, next);
		}

		for (const taskRef of this.#taskRefs.values()) {
			const base = merged.get(taskRef.id) ?? this.#createBaseRef(taskRef.id);
			const next = { ...base, ...taskRef };
			if (base.sessionPath && taskRef.sessionPath && base.sessionPath !== taskRef.sessionPath) {
				next.sessionPath = base.sessionPath;
			}
			if (base.outputPath && taskRef.outputPath && base.outputPath !== taskRef.outputPath) {
				next.outputPath = base.outputPath;
			}
			next.lastUpdatedMs = Math.max(taskRef.lastUpdatedMs ?? 0, next.lastUpdatedMs ?? 0) || undefined;
			next.lastSeenOrder = Math.max(taskRef.lastSeenOrder ?? 0, next.lastSeenOrder ?? 0) || undefined;
			merged.set(taskRef.id, next);
		}

		const refs = Array.from(merged.values())
			.map(ref => this.#finalizeRef(ref))
			.sort((left, right) => {
				const leftScore = this.#getRecencyScore(left);
				const rightScore = this.#getRecencyScore(right);
				if (rightScore !== leftScore) {
					return rightScore - leftScore;
				}
				const byId = left.id.localeCompare(right.id);
				if (byId !== 0) return byId;
				return (left.sessionPath ?? "").localeCompare(right.sessionPath ?? "");
			});

		this.#snapshot = {
			version: this.#snapshot.version + 1,
			updatedAt: Date.now(),
			refs,
			groups: this.#buildGroups(refs),
		};
		return this.#snapshot;
	}

	#createBaseRef(id: string): SubagentViewRef {
		const hierarchy = this.#getHierarchy(id);
		return {
			id,
			rootId: hierarchy.rootId,
			parentId: hierarchy.parentId,
			depth: hierarchy.depth,
		};
	}

	#finalizeRef(ref: SubagentViewRef): SubagentViewRef {
		const next = { ...ref };
		if (!next.outputPath && next.sessionPath?.endsWith(".jsonl")) {
			next.outputPath = `${next.sessionPath.slice(0, -6)}.md`;
		}
		if (!next.sessionPath && next.outputPath?.endsWith(".md")) {
			next.sessionPath = `${next.outputPath.slice(0, -3)}.jsonl`;
		}
		const hierarchy = this.#getHierarchy(next.id);
		next.rootId ??= hierarchy.rootId;
		next.parentId ??= hierarchy.parentId;
		next.depth ??= hierarchy.depth;
		next.status ??= next.sessionPath || next.outputPath ? "completed" : "pending";
		return next;
	}

	#getRecencyScore(ref: SubagentViewRef): number {
		return ref.lastUpdatedMs ?? ref.lastSeenOrder ?? 0;
	}

	#buildGroups(refs: SubagentViewRef[]): SubagentViewGroup[] {
		const groups = new Map<string, SubagentViewGroup>();
		for (const ref of refs) {
			const rootId = ref.rootId ?? this.#getHierarchy(ref.id).rootId;
			const recency = this.#getRecencyScore(ref);
			const existing = groups.get(rootId);
			if (!existing) {
				groups.set(rootId, { rootId, refs: [ref], lastUpdatedMs: recency });
				continue;
			}
			existing.refs.push(ref);
			existing.lastUpdatedMs = Math.max(existing.lastUpdatedMs, recency);
		}

		const sorted = Array.from(groups.values()).sort((left, right) => {
			if (right.lastUpdatedMs !== left.lastUpdatedMs) {
				return right.lastUpdatedMs - left.lastUpdatedMs;
			}
			return left.rootId.localeCompare(right.rootId);
		});

		for (const group of sorted) {
			const rootRef = group.refs.find(ref => ref.id === group.rootId);
			const descendants = group.refs
				.filter(ref => ref.id !== group.rootId)
				.sort((left, right) => {
					const recencyDelta = this.#getRecencyScore(right) - this.#getRecencyScore(left);
					if (recencyDelta !== 0) return recencyDelta;
					return left.id.localeCompare(right.id);
				});
			group.refs = rootRef ? [rootRef, ...descendants] : descendants;
		}

		return sorted.filter(group => group.refs.length > 0);
	}

	#getHierarchy(id: string): { rootId: string; parentId?: string; depth: number } {
		const segments = id.split(".").filter(Boolean);
		const rootId = segments[0] ?? id;
		const parentId = segments.length > 1 ? segments.slice(0, -1).join(".") : undefined;
		return { rootId, parentId, depth: Math.max(0, segments.length - 1) };
	}

	async #resolveArtifactsRootRealpath(): Promise<string | undefined> {
		if (this.#artifactsRootRealpath) {
			return this.#artifactsRootRealpath;
		}
		if (!this.#artifactsDir) {
			return undefined;
		}
		try {
			this.#artifactsRootRealpath = await fs.realpath(this.#artifactsDir);
			return this.#artifactsRootRealpath;
		} catch (error: unknown) {
			if (!isEnoent(error)) {
				logger.warn("Failed to resolve subagent artifacts root", {
					path: this.#artifactsDir,
					error: String(error),
				});
			}
			return undefined;
		}
	}

	async #resolveContainedPath(
		candidatePath: string | undefined,
		artifactsRoot: string,
		kind: "sessionPath" | "outputPath",
		refId: string,
	): Promise<string | undefined> {
		if (!candidatePath) {
			return undefined;
		}

		const absolutePath = path.resolve(candidatePath);

		try {
			const realCandidate = await fs.realpath(absolutePath);
			if (!this.#isPathWithinRoot(realCandidate, artifactsRoot)) {
				logger.warn("Rejected subagent path escaping artifacts root after realpath", {
					refId,
					kind,
					candidatePath: absolutePath,
					realPath: realCandidate,
					artifactsRoot,
				});
				return undefined;
			}
			if (!this.#pathMatchesRefId(realCandidate, refId, kind)) {
				logger.warn("Rejected subagent path with mismatched transcript id", {
					refId,
					kind,
					candidatePath: absolutePath,
					realPath: realCandidate,
				});
				return undefined;
			}
			return realCandidate;
		} catch (error: unknown) {
			if (!isEnoent(error)) {
				logger.warn("Failed to resolve subagent path", {
					refId,
					kind,
					candidatePath: absolutePath,
					error: String(error),
				});
				return undefined;
			}

			const parentDir = path.dirname(absolutePath);
			try {
				const realParent = await fs.realpath(parentDir);
				if (!this.#isPathWithinRoot(realParent, artifactsRoot)) {
					logger.warn("Rejected subagent path with parent outside artifacts root", {
						refId,
						kind,
						candidatePath: absolutePath,
						realParent,
						artifactsRoot,
					});
					return undefined;
				}
				if (!this.#pathMatchesRefId(absolutePath, refId, kind)) {
					logger.warn("Rejected subagent path with mismatched transcript id", {
						refId,
						kind,
						candidatePath: absolutePath,
					});
					return undefined;
				}
				return absolutePath;
			} catch (parentError: unknown) {
				if (!isEnoent(parentError)) {
					logger.warn("Failed to resolve parent for subagent path", {
						refId,
						kind,
						candidatePath: absolutePath,
						error: String(parentError),
					});
				}
				return undefined;
			}
		}
	}

	#pathMatchesRefId(candidatePath: string, refId: string, kind: "sessionPath" | "outputPath"): boolean {
		const expectedExt = kind === "sessionPath" ? ".jsonl" : ".md";
		if (!candidatePath.endsWith(expectedExt)) {
			return false;
		}
		return path.basename(candidatePath, expectedExt) === refId;
	}

	#isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
		const normalizedCandidate = process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
		const normalizedRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
		return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
	}

	#parseSubagentStatus(status: unknown): SubagentStatus | undefined {
		if (typeof status !== "string") {
			return undefined;
		}
		if (
			status === "running" ||
			status === "completed" ||
			status === "failed" ||
			status === "pending" ||
			status === "cancelled"
		) {
			return status;
		}
		return undefined;
	}

	#inferStatusFromTaskResult(record: Record<string, unknown>): SubagentStatus | undefined {
		if (record.aborted === true) {
			return "cancelled";
		}
		const exitCode = this.#readNumber(record.exitCode);
		if (exitCode === undefined) {
			return undefined;
		}
		return exitCode === 0 ? "completed" : "failed";
	}

	#formatSubagentModel(modelOverride: unknown): string | undefined {
		if (typeof modelOverride === "string" && modelOverride.trim().length > 0) {
			return modelOverride;
		}
		if (!Array.isArray(modelOverride)) {
			return undefined;
		}
		const values = modelOverride.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		return values.length > 0 ? values.join(", ") : undefined;
	}


	#parseTimestamp(value: unknown): number | undefined {
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (typeof value !== "string") {
			return undefined;
		}
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	#readString(value: unknown): string | undefined {
		return typeof value === "string" && value.length > 0 ? value : undefined;
	}

	#readNumber(value: unknown): number | undefined {
		return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	}
}
