import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { PackageInfo } from "./types.js";

/**
 * Filter secrets from markdown content
 * Removes API keys, tokens, passwords, and other sensitive patterns
 */
function filterSecrets(content: string): string {
	return content
		.replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]') // Likely API keys/tokens
		.replace(/\b[a-f0-9]{32,}\b/g, '[REDACTED]') // Hex strings (hashes, keys)
		.replace(/Bearer\s+[\w\-\.]+/gi, 'Bearer [REDACTED]') // Bearer tokens
		.replace(/password\s*[=:>\s]+\S+/gi, 'password=[REDACTED]') // Password patterns
		.replace(/api[_-]?key\s*[=:\s]+\S+/gi, 'apikey=[REDACTED]') // API key patterns
		.replace(/secret[_-]?key\s*[=:\s]+\S+/gi, 'secretkey=[REDACTED]') // Secret key patterns
		.replace(/token\s*[=:\s]+\S+/gi, 'token=[REDACTED]') // Token patterns
		.replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-[REDACTED]') // OpenAI-style keys
		.replace(/ghp_[a-zA-Z0-9]{36,}/g, 'ghp_[REDEACTED]') // GitHub tokens
		.replace(/\b\d{16}\b/g, '[REDACTED]') // Credit card numbers
		.replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, '[REDACTED]'); // SSN patterns
}

/**
 * Get badge markdown for export type
 */
function getExportTypeBadge(type: string): string {
	const badges: Record<string, string> = {
		function: '`fn`',
		class: '`class`',
		interface: '`interface`',
		type: '`type`',
		const: '`const`',
		enum: '`enum`',
	};
	return badges[type] || type;
}

/**
 * Generate API reference documentation with exports table
 */
export async function generateApiMd(packages: PackageInfo[], outputDir: string): Promise<void> {
	const sections: string[] = [];

	for (const pkg of packages) {
		const exportsTable = pkg.exports
			.map(exp => {
				const badge = getExportTypeBadge(exp.type);
				return `| ${exp.name} | ${badge} | ${exp.filePath}:${exp.lineNumber} | ${exp.jsdoc?.split('\n')[0] || 'No description'} |`;
			})
			.join('\n');

		sections.push(`## ${pkg.name}

${pkg.description || 'No description available'}

**Version:** ${pkg.version}

**Path:** \`${pkg.path}\`

### Exports

| Name | Type | Location | Description |
|------|------|----------|-------------|
${exportsTable || '| No exports found | | | |'}
`);
	}

	const content = filterSecrets(`# API Reference

> Auto-generated from package exports

---

${sections.join('\n---\n')}`);
	await writeFile(join(outputDir, 'api.md'), content);
}

/**
 * Generate monorepo architecture overview
 */
export async function generateArchitectureMd(packages: PackageInfo[], outputDir: string): Promise<void> {
	const pkgList = packages
		.map(pkg => `- **${pkg.name}** (v${pkg.version})
  ${pkg.description || 'No description'}
  Path: \`${pkg.path}\``)
		.join('\n\n');
	const totalExports = packages.reduce((sum, pkg) => sum + pkg.exports.length, 0);
	const content = filterSecrets(`# Architecture

> Monorepo structure and package organization

## Overview

This monorepo contains ${packages.length} package(s) with a total of ${totalExports} exported members.

## Packages

${pkgList}

## Package Dependencies

> TODO: Extract dependency graph from package.json files

## Build System

> TODO: Document build configuration and scripts
`);
	await writeFile(join(outputDir, 'architecture.md'), content);
}

/**
 * Generate CLI configuration documentation
 */
export async function generateConfigurationMd(outputDir: string): Promise<void> {
	const content = filterSecrets(`# Configuration

> CLI flags and configuration options

## Command-Line Options

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| --help | -h | boolean | Show help message |
| --version | -v | boolean | Show version number |
| --config | -c | string | Path to config file |
| --output | -o | string | Output directory for generated docs |
| --verbose | -V | boolean | Enable verbose output |

## Configuration File

Create a \`docs.config.json\` in your project root:

\`\`\`json
{
  "packages": [
    "packages/*"
  ],
  "output": "docs",
  "exclude": [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.test.ts"
  ],
  "includePrivate": false
}
\`\`\`

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| OMP_DOCS_OUTPUT | Output directory | ./docs |
| OMP_DOCS_VERBOSE | Enable verbose logging | false |
`);
	await writeFile(join(outputDir, 'configuration.md'), content);
}

/**
 * Generate development setup and contribution guide
 */
export async function generateDevelopmentMd(outputDir: string): Promise<void> {
	const content = filterSecrets(`# Development

> Setup and contribution guide

## Prerequisites

- Node.js 18+ or Bun 1.0+
- Git
- pnpm (for workspace management)

## Getting Started

\`\`\`bash
# Clone the repository
git clone <repo-url>
cd <repo-name>

# Install dependencies
pnpm install

# Build the project
pnpm build

# Run tests
pnpm test
\`\`\`

## Project Structure

\`\`\`
packages/
├── doc-cli/          # Documentation generator CLI
│   ├── src/
│   │   ├── cli.ts       # CLI entry point
│   │   ├── scanner.ts   # Package scanner
│   │   ├── generator.ts  # Doc generator
│   │   └── types.ts     # TypeScript types
│   └── package.json
└── ...
\`\`\`

## Development Workflow

1. Create a feature branch from \`main\`
2. Make your changes
3. Add tests for new functionality
4. Ensure all tests pass: \`pnpm test\`
5. Run linting: \`pnpm lint\`
6. Build: \`pnpm build\`
7. Submit a pull request

## Testing

\`\`\`bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test --watch

# Run tests for a specific package
pnpm --filter doc-cli test
\`\`\`

## Building

\`\`\`bash
# Build all packages
pnpm build

# Build a specific package
pnpm --filter doc-cli build
\`\`\`
`);
	await writeFile(join(outputDir, 'development.md'), content);
}

/**
 * Generate installation and basic usage guide
 */
export async function generateUsageMd(outputDir: string): Promise<void> {
	const content = filterSecrets(`# Usage

> Installation and basic usage guide

## Installation

\`\`\`bash
# Install via npm
npm install -g @oh-my-pi/doc-cli

# Or install via bun
bun install -g @oh-my-pi/doc-cli

# Or use via pnpm
pnpm add -g @oh-my-pi/doc-cli
\`\`\`

## Quick Start

\`\`\`bash
# Generate documentation for current project
omp-docs generate

# Specify output directory
omp-docs generate --output ./docs

# Use custom config
omp-docs generate --config docs.config.json

# Enable verbose output
omp-docs generate --verbose
\`\`\`

## Commands

### generate

Generate documentation from source files.

\`\`\`bash
omp-docs generate [options]
\`\`\`

### watch

Watch for file changes and regenerate docs automatically.

\`\`\`bash
omp-docs watch [options]
\`\`\`

### verify

Verify documentation is up-to-date and complete.

\`\`\`bash
omp-docs verify [options]
\`\`\`

## Examples

### Basic Usage

\`\`\`bash
# Generate docs with default settings
omp-docs generate
\`\`\`

### Custom Output

\`\`\`bash
# Output to specific directory
omp-docs generate --output ./documentation
\`\`\`

### Watch Mode

\`\`\`bash
# Watch for changes and regenerate
omp-docs watch --output ./docs
\`\`\`

### CI/CD Integration

\`\`\`bash
# Verify docs are up-to-date in CI
omp-docs verify
\`\`\`
`);
	await writeFile(join(outputDir, 'usage.md'), content);
}

/**
 * Generate all documentation files
 */
export async function generateDocs(packages: PackageInfo[], outputDir: string): Promise<void> {
	await mkdir(outputDir, { recursive: true });
	await Promise.all([
		generateApiMd(packages, outputDir),
		generateArchitectureMd(packages, outputDir),
		generateConfigurationMd(outputDir),
		generateDevelopmentMd(outputDir),
		generateUsageMd(outputDir),
	]);
}
