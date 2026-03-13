import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PackageInfo } from "./types.js";

export async function scanPackages(rootDir: string): Promise<PackageInfo[]> {
	const packages: PackageInfo[] = [];

	async function walkDirectory(dir: string): Promise<void> {
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);

				if (entry.isDirectory()) {
					// Skip node_modules and hidden directories
					if (entry.name === "node_modules" || entry.name.startsWith(".")) {
						continue;
					}
					await walkDirectory(fullPath);
				} else if (entry.name === "package.json") {
					await processPackage(fullPath);
				}
			}
		} catch (error) {
			// Ignore permission errors or directories that don't exist
			if ((error as NodeJS.ErrnoException).code !== "EACCES" && (error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}

	async function processPackage(pkgPath: string): Promise<void> {
		try {
			const content = await fs.readFile(pkgPath, "utf-8");
			const pkg = JSON.parse(content);

			if (pkg.name) {
				packages.push({
					name: pkg.name,
					path: path.dirname(pkgPath),
					version: pkg.version || "0.0.0",
					exports: [],
				});
			}
		} catch (error) {
			// Skip invalid package.json files
			if ((error as NodeJS.ErrnoException).code !== "EACCES" && (error as NodeJS.ErrnoException).code !== "ENOENT") {
				// Log but don't fail for individual package parse errors
				console.warn(`Warning: Failed to parse ${pkgPath}: ${error}`);
			}
		}
	}

	await walkDirectory(rootDir);
	return packages;
}
