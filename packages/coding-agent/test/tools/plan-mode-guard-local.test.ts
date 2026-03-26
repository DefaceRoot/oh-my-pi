import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "../../src/tools";
import { enforcePlanModeWrite, resolvePlanPath } from "../../src/tools/plan-mode-guard";

function makeSession(overrides: {
	artifactsDir?: string | null;
	sessionId?: string | null;
	cwd?: string;
}): ToolSession {
	return {
		cwd: overrides.cwd ?? "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: {
			getPlansDirectory: () => "/plans",
		},
		getArtifactsDir: () => overrides.artifactsDir ?? null,
		getSessionId: () => overrides.sessionId ?? null,
	} as unknown as ToolSession;
}

function makePlanModeSession(planFilePath = ".omp/sessions/plans/manual/plan.md"): ToolSession {
	return {
		...makeSession({}),
		getPlanModeState: () => ({ enabled: true, planFilePath }),
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

describe("enforcePlanModeWrite", () => {
	it("allows markdown files anywhere under the plans root", () => {
		const session = makePlanModeSession();

		expect(() =>
			enforcePlanModeWrite(session, ".omp/sessions/plans/customer-a/plan.md", { op: "create" }),
		).not.toThrow();
		expect(() =>
			enforcePlanModeWrite(session, ".omp/sessions/plans/customer-a/notes/research.md", { op: "update" }),
		).not.toThrow();
	});

	it("blocks plan-verifier artifacts for non plan-verifier agents", () => {
		const session = makePlanModeSession();

		expect(() =>
			enforcePlanModeWrite(
				session,
				".omp/sessions/plans/customer-a/artifacts/plan-verifier/p1/run1/verification.md",
				{ op: "create" },
			),
		).toThrow(/plan mode/i);
	});

	it("allows plan-verifier agents to write plan-verifier artifacts under the plan directory", () => {
		const session = {
			...makePlanModeSession(".omp/sessions/plans/customer-a/plan.md"),
			getRuntimeRole: () => "plan-verifier",
		} as ToolSession;

		expect(() =>
			enforcePlanModeWrite(
				session,
				".omp/sessions/plans/customer-a/artifacts/plan-verifier/p1/run1/verification.md",
				{ op: "create" },
			),
		).not.toThrow();
		expect(() =>
			enforcePlanModeWrite(session, ".omp/sessions/plans/customer-a/artifacts/plan-verifier/p1/run1/findings.json", {
				op: "create",
			}),
		).not.toThrow();

		expect(() =>
			enforcePlanModeWrite(session, ".omp/sessions/plans/customer-a/notes/research.md", { op: "create" }),
		).toThrow(/plan mode/i);
	});

	it("blocks non-markdown plan files and paths outside the plans root", () => {
		const session = makePlanModeSession();

		expect(() =>
			enforcePlanModeWrite(session, ".omp/sessions/plans/customer-a/notes/state.json", { op: "create" }),
		).toThrow(/plan mode/i);
		expect(() => enforcePlanModeWrite(session, "/repo/outside.md", { op: "create" })).toThrow(/plan mode/i);
	});
});
