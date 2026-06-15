import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { enforcePlanModeWrite, resolvePlanPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";

interface SessionOverrides {
	artifactsDir?: string | null;
	sessionId?: string | null;
	cwd?: string;
	planMode?: PlanModeState;
	persistToRepo?: boolean;
}

function makeSession(overrides: SessionOverrides): ToolSession {
	const persistToRepo = overrides.persistToRepo ?? false;
	return {
		cwd: overrides.cwd ?? "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: {
			getPlansDirectory: () => "/plans",
			get: (key: string) => {
				if (key === "plan.persistToRepo") return persistToRepo;
				return undefined;
			},
		},
		getArtifactsDir: () => overrides.artifactsDir ?? null,
		getSessionId: () => overrides.sessionId ?? null,
		getPlanModeState: () => overrides.planMode,
	} as unknown as ToolSession;
}

describe("resolvePlanPath local:// support", () => {
	it("resolves local:// paths under session artifacts local root", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", sessionId: "abc" });
		expect(resolvePlanPath(session, "local://handoffs/result.json")).toBe(
			path.join("/tmp/agent-artifacts", "local", "handoffs", "result.json"),
		);
	});

	it("falls back to os tmp root when artifacts dir is unavailable", () => {
		const session = makeSession({ artifactsDir: null, sessionId: "session-42" });
		expect(resolvePlanPath(session, "local://memo.txt")).toBe(
			path.join(os.tmpdir(), "omp-local", "session-42", "memo.txt"),
		);
	});
});

describe("resolvePlanPath resolves literally (no plan-mode redirect)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("resolves a bare path against cwd regardless of plan mode", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(resolvePlanPath(session, "PLAN.md")).toBe(path.join("/repo", "PLAN.md"));
		expect(resolvePlanPath(session, "src/foo.ts")).toBe(path.join("/repo", "src/foo.ts"));
	});

	it("resolves a local:// plan file to the session local root", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(resolvePlanPath(session, "local://some-plan.md")).toBe(
			path.join("/tmp/agent-artifacts", "local", "some-plan.md"),
		);
	});

	it("unwraps a `[PATH#TAG]` hashline header to the inner filesystem path", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(resolvePlanPath(session, "[local://some-plan.md#ABCD]")).toBe(
			path.join("/tmp/agent-artifacts", "local", "some-plan.md"),
		);
		expect(resolvePlanPath(session, "[/tmp/agent-artifacts/local/some-plan.md#ABCD]")).toBe(
			path.join("/tmp/agent-artifacts", "local", "some-plan.md"),
		);
		expect(resolvePlanPath(session, "[local://some-plan.md]")).toBe(
			path.join("/tmp/agent-artifacts", "local", "some-plan.md"),
		);
	});

	it("leaves malformed bracketed paths untouched so downstream errors surface", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		// Inner path with a non-tag `#`, selector tail, or empty body falls outside
		// the strict header shape and is resolved literally — `resolveToCwd` on
		// `/repo` keeps the bracketed name intact so the eventual write/edit
		// reports a real "file not found" instead of silently rewriting the target.
		expect(resolvePlanPath(session, "[/tmp/x#nothex]")).toBe(path.join("/repo", "[/tmp/x#nothex]"));
		expect(resolvePlanPath(session, "[/tmp/x#ABCD:1-2]")).toBe(path.join("/repo", "[/tmp/x#ABCD:1-2]"));
	});
});

describe("enforcePlanModeWrite (working tree read-only, local:// sandbox writable)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("accepts writes to any local:// file", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "local://auth-refactor-plan.md", { op: "create" })).not.toThrow();
		expect(() => enforcePlanModeWrite(session, "local://scratch/notes.md", { op: "update" })).not.toThrow();
	});

	it("rejects writes to the working tree", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).toThrow(/working tree is read-only/);
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "create" })).toThrow(/working tree is read-only/);
	});

	it("rejects deletes and renames outright", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { op: "delete" })).toThrow(
			/deleting files is not allowed/,
		);
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { move: "local://renamed.md" })).toThrow(
			/renaming files is not allowed/,
		);
	});

	it("is a no-op when plan mode is disabled", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo" });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).not.toThrow();
	});
});

describe("enforcePlanModeWrite accepts absolute local-sandbox paths", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("allows the absolute path returned by `read local://...` (== sandbox-resolved path)", async () => {
		// Use an existing tmp directory so the realpath check inside the guard
		// sees a real filesystem (macOS collapses /tmp -> /private/tmp etc.).
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		const session = makeSession({ artifactsDir, planMode });
		const absolute = resolvePlanPath(session, "local://my-plan.md");
		expect(() => enforcePlanModeWrite(session, absolute, { op: "update" })).not.toThrow();
	});

	it("allows bracketed hashline headers for local sandbox paths", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		const session = makeSession({ artifactsDir, planMode });
		const absolute = resolvePlanPath(session, "local://my-plan.md");

		// Strict hashline shape `[PATH]` or `[PATH#XXXX]` is unwrapped to the
		// inner path for both the sandbox check and the eventual resolution.
		expect(() => enforcePlanModeWrite(session, `[${absolute}#ABCD]`, { op: "update" })).not.toThrow();
		expect(() => enforcePlanModeWrite(session, `[${absolute}]`, { op: "update" })).not.toThrow();
		expect(() => enforcePlanModeWrite(session, `[local://my-plan.md#ABCD]`, { op: "update" })).not.toThrow();
	});

	it("rejects malformed bracketed headers instead of silently unwrapping them", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });

		// Selector tails (`#TAG:lines`), non-hex tags, and short tags fall outside
		// the strict header shape; we leave them alone so the downstream resolver
		// surfaces the real error rather than treating the bracketed blob as a path.
		expect(() =>
			enforcePlanModeWrite(session, "[/tmp/agent-artifacts/local/plan.md#ABCD:1-2]", { op: "update" }),
		).toThrow(/working tree is read-only/);
		expect(() =>
			enforcePlanModeWrite(session, "[/tmp/agent-artifacts/local/plan.md#nothex]", { op: "update" }),
		).toThrow(/working tree is read-only/);
	});

	it("still rejects absolute paths outside the local sandbox", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });

		expect(() => enforcePlanModeWrite(session, "/repo/src/foo.ts", { op: "update" })).toThrow(
			/working tree is read-only/,
		);
		expect(() => enforcePlanModeWrite(session, "[/repo/src/foo.ts#ABCD]", { op: "update" })).toThrow(
			/working tree is read-only/,
		);
	});
});

describe("enforcePlanModeWrite repo-backed plan persistence", () => {
	const repoPlanMode: PlanModeState = { enabled: true, planFilePath: "local://PLAN.md" };
	const repoRoot = "/repo";

	it("permits create under .plans when persistToRepo is true", () => {
		const session = makeSession({ cwd: repoRoot, planMode: repoPlanMode, persistToRepo: true });
		expect(() => enforcePlanModeWrite(session, `${repoRoot}/.plans/foo/plan.md`, { op: "create" })).not.toThrow();
	});

	it("permits update under .plans when persistToRepo is true", () => {
		const session = makeSession({ cwd: repoRoot, planMode: repoPlanMode, persistToRepo: true });
		expect(() => enforcePlanModeWrite(session, `${repoRoot}/.plans/foo/plan.md`, { op: "update" })).not.toThrow();
	});

	it("permits supporting artifacts under the same .plans tree", () => {
		const session = makeSession({ cwd: repoRoot, planMode: repoPlanMode, persistToRepo: true });
		expect(() => enforcePlanModeWrite(session, `${repoRoot}/.plans/foo/notes.md`, { op: "create" })).not.toThrow();
	});

	it("rejects writes outside .plans even when persistToRepo is true", () => {
		const session = makeSession({ cwd: repoRoot, planMode: repoPlanMode, persistToRepo: true });
		expect(() => enforcePlanModeWrite(session, `${repoRoot}/src/foo.ts`, { op: "update" })).toThrow(
			/only the plan file may be modified/,
		);
	});

	it("rejects move/rename under .plans when persistToRepo is true", () => {
		const session = makeSession({ cwd: repoRoot, planMode: repoPlanMode, persistToRepo: true });
		expect(() =>
			enforcePlanModeWrite(session, `${repoRoot}/.plans/foo/plan.md`, {
				move: `${repoRoot}/.plans/foo/plan-v2.md`,
			}),
		).toThrow(/Plan mode: renaming files is not allowed/);
	});

	it("rejects delete under .plans when persistToRepo is true", () => {
		const session = makeSession({ cwd: repoRoot, planMode: repoPlanMode, persistToRepo: true });
		expect(() => enforcePlanModeWrite(session, `${repoRoot}/.plans/foo/plan.md`, { op: "delete" })).toThrow(
			/Plan mode: deleting files is not allowed/,
		);
	});

	it("rejects .plans writes when persistToRepo is false", () => {
		const session = makeSession({ cwd: repoRoot, planMode: repoPlanMode, persistToRepo: false });
		expect(() => enforcePlanModeWrite(session, `${repoRoot}/.plans/foo/plan.md`, { op: "create" })).toThrow(
			/only the plan file may be modified/,
		);
	});

	it("still allows the active plan file when persistToRepo is false", () => {
		const session = makeSession({
			artifactsDir: "/tmp/agent-artifacts",
			planMode: repoPlanMode,
			persistToRepo: false,
		});
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "update" })).not.toThrow();
	});
});

describe("resolvePlanPath .plans regression", () => {
	it("does not redirect .plans/foo/plan.md to the local://PLAN.md alias", () => {
		const planMode: PlanModeState = { enabled: true, planFilePath: "local://PLAN.md" };
		const session = makeSession({ cwd: "/repo", planMode });
		const dotPlansPath = "/repo/.plans/foo/plan.md";
		expect(resolvePlanPath(session, dotPlansPath)).toBe(dotPlansPath);
	});
});
