import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(implementationEnginePath).text();

function extractCategoryPrefixes(source: string): string[] {
	const categoriesBlock = source.match(/const WORKTREE_CATEGORY_OPTIONS:[\s\S]*?=\s*\[(?<body>[\s\S]*?)\n\];/);
	expect(categoriesBlock?.groups?.body).toBeDefined();
	return [...categoriesBlock!.groups!.body.matchAll(/prefix:\s*"([^"]+)"/g)].map((match) => match[1]);
}

describe("implementation-engine phase 1 setup safety", () => {
	test("category options contain exactly 8 required prefixes", async () => {
		const source = await readExtensionSource();
		const prefixes = extractCategoryPrefixes(source);

		expect(prefixes).toEqual([
			"breaking/",
			"feature/",
			"fix/",
			"perf/",
			"refactor/",
			"docs/",
			"chore/",
			"security/",
		]);
	});

	test("cleanup helper exists and performs remove + prune + branch delete attempt", async () => {
		const source = await readExtensionSource();
		const helperStart = source.indexOf("export async function cleanupFailedWorktree(");
		expect(helperStart).toBeGreaterThan(-1);
		const helperEnd = source.indexOf("\nasync function ", helperStart + 1);
		const helperSource = source.slice(helperStart, helperEnd === -1 ? source.length : helperEnd);
		expect(helperSource).toMatch(/fs\.rmSync\(/);
		expect(helperSource).toMatch(/runAllowFail\(\["git", "worktree", "prune"\], repoRoot\)/);
		expect(helperSource).toMatch(/if \(branchName\)[\s\S]*runAllowFail\(\["git", "branch", "-D", branchName\], repoRoot\)/);
	});

	test("setup failure path runs cleanup before notifying the error", async () => {
		const source = await readExtensionSource();
		expect(source).toMatch(
			/\} catch \(err\) \{[\s\S]*await cleanupFailedWorktree\([\s\S]*ctx\.ui\.notify\(`implementation-engine error: \$\{msg\}`, "error"\)/,
		);
	});
});
