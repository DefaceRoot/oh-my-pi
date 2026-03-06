import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPruneCheck } from "./prune-check";

interface TempRepoOptions {
	agentNames: string[];
	modelsYmlIds?: string[];
	modelsJsonByProvider?: Record<string, string[]>;
	matrix: {
		agents: string[];
		models: string[];
	};
}

async function withTempRepo<T>(options: TempRepoOptions, fn: (repoRoot: string, matrixPath: string) => T): Promise<T> {
	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prune-check-test-"));
	try {
		const agentsDir = path.join(repoRoot, "agents");
		const modelsDir = path.join(repoRoot, "models");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.mkdirSync(modelsDir, { recursive: true });

		for (const agentName of options.agentNames) {
			const fileName = `${agentName}.md`;
			fs.writeFileSync(path.join(agentsDir, fileName), `---\nname: ${agentName}\n---\n`, "utf8");
		}

		if ((options.modelsYmlIds ?? []).length > 0) {
			const modelLines = [
				"providers:",
				"  github-copilot:",
				"    models:",
				...(options.modelsYmlIds ?? []).flatMap((id) => [
					`      - id: ${id.split("/")[1] ?? id}`,
					"        name: Test Model",
				]),
			];
			fs.writeFileSync(path.join(repoRoot, "models.yml"), `${modelLines.join("\n")}\n`, "utf8");
		}

		for (const [provider, ids] of Object.entries(options.modelsJsonByProvider ?? {})) {
			const payload = {
				models: ids.map((id) => ({ id: id.includes("/") ? id.split("/")[1] : id })),
			};
			fs.writeFileSync(path.join(modelsDir, `${provider}.json`), JSON.stringify(payload, null, 2), "utf8");
		}

		const matrixPath = path.join(repoRoot, "prune-matrix.json");
		const matrix = {
			agents: { pruned: options.matrix.agents },
			models: { pruned: options.matrix.models },
		};
		fs.writeFileSync(matrixPath, JSON.stringify(matrix, null, 2), "utf8");

		return fn(repoRoot, matrixPath);
	} finally {
		fs.rmSync(repoRoot, { recursive: true, force: true });
	}
}

describe("prune-check", () => {
	test("fails when any pruned entry still exists", async () => {
		await withTempRepo(
			{
				agentNames: ["obsolete-agent"],
				modelsYmlIds: ["github-copilot/dead-model"],
				modelsJsonByProvider: {
					"test-provider": ["test-provider/dead-json-model"],
				},
				matrix: {
					agents: ["obsolete-agent"],
					models: ["github-copilot/dead-model", "test-provider/dead-json-model"],
				},
			},
			(repoRoot, matrixPath) => {
				const result = runPruneCheck({ repoRoot, pruneMatrixPath: matrixPath });
				expect(result.ok).toBe(false);
				expect(result.lingeringAgents).toEqual(["obsolete-agent"]);
				expect(result.lingeringModels.sort()).toEqual([
					"github-copilot/dead-model",
					"test-provider/dead-json-model",
				]);
			},
		);
	});

	test("passes when all pruned entries are absent", async () => {
		await withTempRepo(
			{
				agentNames: ["implement"],
				modelsYmlIds: ["github-copilot/live-model"],
				modelsJsonByProvider: {
					"test-provider": ["test-provider/live-json-model"],
				},
				matrix: {
					agents: ["obsolete-agent"],
					models: ["github-copilot/dead-model", "test-provider/dead-json-model"],
				},
			},
			(repoRoot, matrixPath) => {
				const result = runPruneCheck({ repoRoot, pruneMatrixPath: matrixPath });
				expect(result).toEqual({
					ok: true,
					lingeringAgents: [],
					lingeringModels: [],
				});
			},
		);
	});
});
