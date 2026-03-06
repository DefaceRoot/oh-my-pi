import fs from "node:fs";
import path from "node:path";

interface PruneMatrix {
	agents?: {
		pruned?: string[];
	};
	models?: {
		pruned?: string[];
	};
}

interface PruneCheckOptions {
	repoRoot: string;
	pruneMatrixPath: string;
}

export interface PruneCheckResult {
	ok: boolean;
	lingeringAgents: string[];
	lingeringModels: string[];
}

function resolveFromCwd(inputPath: string): string {
	return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function parseArgs(argv: string[]): { sessionsDir?: string; pruneMatrixPath: string; repoRoot: string } {
	let sessionsDir: string | undefined;
	let pruneMatrixPath = "scripts/prune-matrix.json";
	let repoRoot = path.resolve(import.meta.dir, "..");

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--sessions-dir") {
			sessionsDir = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--prune-matrix") {
			pruneMatrixPath = argv[index + 1] ?? pruneMatrixPath;
			index += 1;
			continue;
		}
		if (arg === "--repo-root") {
			repoRoot = argv[index + 1] ? resolveFromCwd(argv[index + 1]) : repoRoot;
			index += 1;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
	}

	return {
		sessionsDir,
		pruneMatrixPath: resolveFromCwd(pruneMatrixPath),
		repoRoot,
	};
}

function printHelp(): void {
	console.log(
		"Usage: ~/.bun/bin/bun scripts/prune-check.ts --sessions-dir ~/.omp/agent/sessions --prune-matrix scripts/prune-matrix.json [--repo-root <path>]",
	);
}

function parsePruneMatrix(content: string): PruneMatrix {
	const parsed = JSON.parse(content) as PruneMatrix;
	return {
		agents: { pruned: parsed.agents?.pruned ?? [] },
		models: { pruned: parsed.models?.pruned ?? [] },
	};
}

function collectAgentNames(repoRoot: string): Set<string> {
	const agentsDir = path.join(repoRoot, "agents");
	if (!fs.existsSync(agentsDir)) {
		return new Set();
	}

	const names = new Set<string>();
	for (const fileName of fs.readdirSync(agentsDir)) {
		if (!fileName.endsWith(".md")) {
			continue;
		}
		const content = fs.readFileSync(path.join(agentsDir, fileName), "utf8");
		const match = content.match(/^name:\s*([^\n]+)\s*$/m);
		if (match?.[1]) {
			names.add(match[1].trim());
		}
	}
	return names;
}

function collectModelsFromJson(repoRoot: string): Set<string> {
	const modelsDir = path.join(repoRoot, "models");
	const models = new Set<string>();
	if (!fs.existsSync(modelsDir)) {
		return models;
	}

	for (const fileName of fs.readdirSync(modelsDir)) {
		if (!fileName.endsWith(".json")) {
			continue;
		}
		const provider = path.basename(fileName, ".json");
		const filePath = path.join(modelsDir, fileName);
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		} catch {
			continue;
		}

		if (!parsed || typeof parsed !== "object") {
			continue;
		}
		const modelList = (parsed as { models?: unknown }).models;
		if (!Array.isArray(modelList)) {
			continue;
		}
		for (const modelEntry of modelList) {
			if (!modelEntry || typeof modelEntry !== "object") {
				continue;
			}
			const id = (modelEntry as { id?: unknown }).id;
			if (typeof id === "string" && id.trim().length > 0) {
				models.add(`${provider}/${id.trim()}`);
			}
		}
	}

	return models;
}

function collectModelsFromYaml(repoRoot: string): Set<string> {
	const modelsYmlPath = path.join(repoRoot, "models.yml");
	const models = new Set<string>();
	if (!fs.existsSync(modelsYmlPath)) {
		return models;
	}

	const lines = fs.readFileSync(modelsYmlPath, "utf8").split(/\r?\n/);
	let inProvidersSection = false;
	let currentProvider: string | undefined;

	for (const line of lines) {
		if (!inProvidersSection) {
			if (/^providers:\s*$/.test(line)) {
				inProvidersSection = true;
			}
			continue;
		}

		if (/^\S/.test(line)) {
			break;
		}

		const providerMatch = line.match(/^ {2}([a-zA-Z0-9._-]+):\s*$/);
		if (providerMatch) {
			currentProvider = providerMatch[1];
			continue;
		}

		const idMatch = line.match(/^\s*-\s+id:\s*([^\s#]+)\s*$/);
		if (idMatch && currentProvider) {
			models.add(`${currentProvider}/${idMatch[1]}`);
		}
	}

	return models;
}

function collectModelIds(repoRoot: string): Set<string> {
	const modelIds = collectModelsFromJson(repoRoot);
	for (const modelId of collectModelsFromYaml(repoRoot)) {
		modelIds.add(modelId);
	}
	return modelIds;
}

export function runPruneCheck(options: PruneCheckOptions): PruneCheckResult {
	const matrixRaw = fs.readFileSync(options.pruneMatrixPath, "utf8");
	const matrix = parsePruneMatrix(matrixRaw);
	const agentNames = collectAgentNames(options.repoRoot);
	const modelIds = collectModelIds(options.repoRoot);

	const lingeringAgents = (matrix.agents?.pruned ?? []).filter((agent) => agentNames.has(agent));
	const lingeringModels = (matrix.models?.pruned ?? []).filter((model) => modelIds.has(model));

	return {
		ok: lingeringAgents.length === 0 && lingeringModels.length === 0,
		lingeringAgents,
		lingeringModels,
	};
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	const result = runPruneCheck({
		repoRoot: args.repoRoot,
		pruneMatrixPath: args.pruneMatrixPath,
	});

	if (!result.ok) {
		if (result.lingeringAgents.length > 0) {
			console.error(`Pruned agents still present: ${result.lingeringAgents.join(", ")}`);
		}
		if (result.lingeringModels.length > 0) {
			console.error(`Pruned models still present: ${result.lingeringModels.join(", ")}`);
		}
		process.exit(1);
	}

	console.log("Prune check passed: all pruned entries are absent.");
}
