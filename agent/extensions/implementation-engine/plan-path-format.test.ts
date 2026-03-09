import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	WORKFLOW_ARTIFACT_DIR_TEMPLATES,
	deriveWorkflowArtifactDirTemplate,
} from "./workflow-action-state.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");
const ompCommandPath = path.join(repoRoot, "packages/coding-agent/src/task/omp-command.ts");
const builtinRegistryPath = path.join(
	repoRoot,
	"packages/coding-agent/src/slash-commands/builtin-registry.ts",
);

const readFile = async (filePath: string): Promise<string> => Bun.file(filePath).text();

describe("implementation-engine plan path format", () => {
	test("uses only the nested session plan path in manual prompts and validation helpers", async () => {
		const source = await readFile(implementationEnginePath);

		expect(source).toContain("@.omp/sessions/plans/<plan-slug>/plan.md");
		expect(source).toContain("Attach a valid @.omp/sessions/plans/.../plan.md file");
		expect(source).toContain(".omp/sessions/plans/manual/plan.md");
		expect(source).not.toContain("@docs/plans/");
		expect(source).not.toContain("normalized.startsWith(\"/docs/plans/\")");
	});

	test("publishes explicit planned and non-planned session artifact templates", async () => {
		const source = await readFile(ompCommandPath);

		expect(source).toContain(
			'planned: ".omp/sessions/plans/<plan>/<nested_dir_for_all_subagents>"',
		);
		expect(source).toContain(
			'nonPlanned: ".omp/sessions/<session>/<nested_dir_for_all_subagents>"',
		);
	});

	test("plan slash command guidance points to nested planned artifact paths", async () => {
		const source = await readFile(builtinRegistryPath);

		expect(source).toContain("SESSION_ARTIFACT_DIR_TEMPLATES.planned");
	});

	test("workflow stage mapping keeps planned and non-planned artifact templates distinct", () => {
		expect(deriveWorkflowArtifactDirTemplate("plan")).toBe(
			WORKFLOW_ARTIFACT_DIR_TEMPLATES.planned,
		);
		expect(deriveWorkflowArtifactDirTemplate("submit-pr")).toBe(
			WORKFLOW_ARTIFACT_DIR_TEMPLATES.planned,
		);
		expect(deriveWorkflowArtifactDirTemplate("none")).toBe(
			WORKFLOW_ARTIFACT_DIR_TEMPLATES.nonPlanned,
		);
	});
});