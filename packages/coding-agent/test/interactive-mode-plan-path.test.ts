import { describe, expect, it } from "bun:test";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const interactiveModePath = path.join(packageRoot, "src", "modes", "interactive-mode.ts");

const readFile = async (filePath: string): Promise<string> => Bun.file(filePath).text();

describe("interactive mode default plan path", () => {
	it("uses the canonical manual plan file under the plans directory", async () => {
		const source = await readFile(interactiveModePath);

		expect(source).toContain('return ".omp/sessions/plans/manual/plan.md";');
		expect(source).not.toContain('return "local://PLAN.md";');
	});
});
