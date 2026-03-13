#!/usr/bin/env bun
/**
 * Documentation automation CLI
 *
 * Commands:
 *   generate  - Generate documentation from source files
 *   watch     - Watch for file changes and regenerate docs
 *   verify    - Verify documentation is up-to-date
 */

import { parseArgs } from "node:util";

interface CliArgs {
	command?: string;
	positionals: string[];
	values: Record<string, string | boolean>;
}

function parseCliArgs(): CliArgs {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			help: {
				type: "boolean",
				short: "h",
			},
			version: {
				type: "boolean",
				short: "v",
			},
			// Global options
			config: {
				type: "string",
				short: "c",
				description: "Path to config file",
			},
			output: {
				type: "string",
				short: "o",
				description: "Output directory",
			},
			verbose: {
				type: "boolean",
				short: "V",
				description: "Verbose output",
			},
		},
	});

	const command = positionals[0];

	return { command, positionals, values };
}

function showHelp(): void {
	console.log(`
Documentation automation CLI

USAGE:
  omp-docs <command> [options]

COMMANDS:
  generate    Generate documentation from source files
  watch       Watch for file changes and regenerate docs
  verify      Verify documentation is up-to-date

OPTIONS:
  -c, --config <path>   Path to config file
  -o, --output <dir>    Output directory
  -V, --verbose         Verbose output
  -h, --help            Show this help message
  -v, --version         Show version

EXAMPLES:
  omp-docs generate
  omp-docs watch --output ./docs
  omp-docs verify --config docs.config.json
`);
}

async function showVersion(): Promise<void> {
	const pkg = await import("../package.json", { with: { type: "json" } });
	console.log(`omp-docs v${pkg.default.version}`);
}

async function handleGenerate(options: Record<string, string | boolean>): Promise<void> {
	console.log("Generating documentation...");
	if (options.verbose) console.log("Options:", options);
	// TODO: Implement generate logic
}

async function handleWatch(options: Record<string, string | boolean>): Promise<void> {
	console.log("Watching for changes...");
	if (options.verbose) console.log("Options:", options);
	// TODO: Implement watch logic
}

async function handleVerify(options: Record<string, string | boolean>): Promise<void> {
	const { scanPackages } = await import("./scanner.js");
	
	const rootDir = process.cwd();
	const _configPath = typeof options.config === "string" ? options.config : undefined;
	const outputDir = typeof options.output === "string" ? options.output : "./docs";
	
	if (options.verbose) console.log(`Scanning packages from ${rootDir}...`);
	
	const packages = await scanPackages(rootDir);
	
	if (packages.length === 0) {
		console.log("No packages found to verify.");
		process.exit(0);
	}
	
	console.log(`Found ${packages.length} package(s):`);
	for (const pkg of packages) {
		console.log(`  - ${pkg.name}@${pkg.version}`);
		if (options.verbose && pkg.description) {
			console.log(`    ${pkg.description}`);
		}
	}
	
	// Check documentation status
	let documentedCount = 0;
	const missingDocs: string[] = [];
	
	for (const pkg of packages) {
		const hasDocs = pkg.description && pkg.description.length > 0;
		if (hasDocs) {
			documentedCount++;
		} else {
			missingDocs.push(pkg.name);
		}
	}
	
	const coverage = (documentedCount / packages.length) * 100;
	
	console.log(`\nDocumentation Coverage: ${coverage.toFixed(1)}%`);
	console.log(`  Documented: ${documentedCount}/${packages.length}`);
	
	if (missingDocs.length > 0) {
		console.log(`\nMissing or incomplete documentation for:`);
		for (const name of missingDocs) {
			console.log(`  - ${name}`);
		}
		process.exit(1);
	} else {
		console.log("\n✓ All packages are documented!");
		process.exit(0);
	}
}

async function main(): Promise<void> {
	const { command, values } = parseCliArgs();

	// Handle global flags
	if (values.help) {
		showHelp();
		process.exit(0);
	}

	if (values.version) {
		await showVersion();
		process.exit(0);
	}

	// Handle commands
	switch (command) {
		case "generate": {
			await handleGenerate(values);
			break;
		}
		case "watch": {
			await handleWatch(values);
			break;
		}
		case "verify": {
			await handleVerify(values);
			break;
		}
		case undefined: {
			console.error("Error: No command specified\n");
			showHelp();
			process.exit(1);
			break;
		}
		default: {
			console.error(`Error: Unknown command '${command}'\n`);
			showHelp();
			process.exit(1);
			break;
		}
	}
}

main().catch(error => {
	console.error("Fatal error:", error);
	process.exit(1);
});
