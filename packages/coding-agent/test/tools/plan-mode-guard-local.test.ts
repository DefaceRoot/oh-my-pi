import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { PlanModeState } from "../../src/plan-mode/state";
import type { ToolSession } from "../../src/tools";
import { enforcePlanModeWrite, resolvePlanPath } from "../../src/tools/plan-mode-guard";

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

describe("resolvePlanPath plan-mode redirect", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://PLAN.md" };
	const approvedPlanMode: PlanModeState = { enabled: true, planFilePath: "local://APPROVED.md" };

	it("redirects bare PLAN.md to the session plan path when plan mode is active", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(resolvePlanPath(session, "PLAN.md")).toBe(path.join("/tmp/agent-artifacts", "local", "PLAN.md"));
	});

	it("redirects ./PLAN.md and absolute cwd-PLAN.md alike", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		const expected = path.join("/tmp/agent-artifacts", "local", "PLAN.md");
		expect(resolvePlanPath(session, "./PLAN.md")).toBe(expected);
		expect(resolvePlanPath(session, "/repo/PLAN.md")).toBe(expected);
	});

	it("does not redirect when plan mode is disabled", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo" });
		expect(resolvePlanPath(session, "PLAN.md")).toBe(path.join("/repo", "PLAN.md"));
	});

	it("does not redirect paths whose basename differs from the plan basename", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(resolvePlanPath(session, "src/foo.ts")).toBe(path.join("/repo", "src/foo.ts"));
	});

	it("leaves an explicit local://PLAN.md unchanged", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(resolvePlanPath(session, "local://PLAN.md")).toBe(path.join("/tmp/agent-artifacts", "local", "PLAN.md"));
	});

	it("redirects PLAN.md aliases to the active titled plan artifact", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode: approvedPlanMode });
		const expected = path.join("/tmp/agent-artifacts", "local", "APPROVED.md");
		expect(resolvePlanPath(session, "PLAN.md")).toBe(expected);
		expect(resolvePlanPath(session, "./PLAN.md")).toBe(expected);
		expect(resolvePlanPath(session, "/repo/PLAN.md")).toBe(expected);
		expect(resolvePlanPath(session, "local://PLAN.md")).toBe(expected);
	});
});

describe("enforcePlanModeWrite plan-mode redirect", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://PLAN.md" };
	const approvedPlanMode: PlanModeState = { enabled: true, planFilePath: "local://APPROVED.md" };

	it("accepts bare PLAN.md as a write to the plan file", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "update" })).not.toThrow();
	});

	it("still rejects non-plan paths in plan mode", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).toThrow(
			/only the plan file may be modified/,
		);
	});

	it("accepts bare PLAN.md as a write to a titled active plan file", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode: approvedPlanMode });
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "update" })).not.toThrow();
	});

	it("rejects deletes of PLAN.md even when basename matches", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "delete" })).toThrow(
			/Plan mode: deleting files is not allowed/,
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
