import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { PackageInfo } from "./types.js";

export async function scanPackages(rootDir: string): Promise<PackageInfo[]> {
	const packages: PackageInfo[] = [];
	const packagesDir = join(rootDir, "packages");

	try {
		const entries = await readdir(packagesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const packagePath = join(packagesDir, entry.name);
				try {
					const pkgJson = JSON.parse(await readFile(join(packagePath, "package.json"), "utf-8"));
					if (!pkgJson.private) {
						packages.push({
							name: pkgJson.name,
							path: packagePath,
							version: pkgJson.version,
							description: pkgJson.description,
							exports: [],
						});
					}
				} catch {}
			}
		}
	} catch {}

	return packages;
}
