import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { PackageInfo } from "./types.js";

export async function generateDocs(packages: PackageInfo[], outputDir: string): Promise<void> {
	await mkdir(outputDir, { recursive: true });

	const apiDoc = packages.map(p => `## ${p.name}\n\n${p.description || ""}\n`).join("\n");
	await writeFile(join(outputDir, "api.md"), `# API Reference\n\n${apiDoc}`);
}
