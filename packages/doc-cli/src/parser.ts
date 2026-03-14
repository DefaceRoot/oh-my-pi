/**
 * TypeScript export parser with JSDoc extraction
 * Parses TypeScript files to find exports and their associated documentation
 */

export interface ExportInfo {
	name: string;
	type: "function" | "class" | "interface" | "type" | "const" | "enum";
	jsdoc?: string;
	lineNumber: number;
	isAsync: boolean;
}

/**
 * Parse a TypeScript file and extract all exports with their JSDoc comments
 */
export function parseFile(content: string, _filePath: string): ExportInfo[] {
	const exports: ExportInfo[] = [];
	const _lines = content.split("\n");

	// Combined regex pattern to match all export types
	// Matches: export [async] function name, export class name, export interface name,
	//          export type name, export const name, export enum name
	const exportPattern =
		/^export\s+(?:async\s+)?function\s+(\w+)|^export\s+class\s+(\w+)|^export\s+interface\s+(\w+)|^export\s+type\s+(\w+)|^export\s+const\s+(\w+)|^export\s+enum\s+(\w+)/gm;

	// Pattern to match JSDoc comments: /** ... */
	const _jsdocPattern = /\/\*\*[\s\S]*?\*\//;

	let match: RegExpExecArray | null;
	while (true) {
		match = exportPattern.exec(content);
		if (match === null) break;
		const fullMatch = match[0];
		const matchIndex = match.index;

		// Determine the export type and name
		let name: string;
		let type: ExportInfo["type"];
		let isAsync = false;

		if (match[1]) {
			// Function
			name = match[1];
			type = "function";
			isAsync = fullMatch.includes("async");
		} else if (match[2]) {
			// Class
			name = match[2];
			type = "class";
		} else if (match[3]) {
			// Interface
			name = match[3];
			type = "interface";
		} else if (match[4]) {
			// Type
			name = match[4];
			type = "type";
		} else if (match[5]) {
			// Const
			name = match[5];
			type = "const";
		} else if (match[6]) {
			// Enum
			name = match[6];
			type = "enum";
		} else {
			continue; // Skip if no match found
		}

		// Calculate line number
		const beforeMatch = content.substring(0, matchIndex);
		const lineNumber = beforeMatch.split("\n").length;

		// Extract JSDoc comment before the export
		const jsdoc = extractJSDoc(content, matchIndex);

		exports.push({
			name,
			type,
			jsdoc,
			lineNumber,
			isAsync,
		});
	}

	return exports;
}

/**
 * Extract JSDoc comment that immediately precedes the given position
 */
function extractJSDoc(content: string, exportIndex: number): string | undefined {
	// Look backwards from the export position
	const beforeExport = content.substring(0, exportIndex);

	// Remove trailing whitespace
	const trimmedBefore = beforeExport.trimEnd();

	// Check if the last thing before the export is a JSDoc comment
	const jsdocMatch = trimmedBefore.match(/\/\*\*[\s\S]*?\*\/\s*$/);
	if (jsdocMatch) {
		const jsdoc = jsdocMatch[0];
		// Extract just the content (remove /** and */)
		const contentMatch = jsdoc.match(/^\/\*\*([\s\S]*?)\*\/$/);
		if (contentMatch) {
			// Clean up the content: remove leading * and whitespace
			return contentMatch[1]
				.split("\n")
				.map(line => line.replace(/^\s*\*\s?/, "").trim())
				.join("\n")
				.trim();
		}
	}

	return undefined;
}

/**
 * Parse a TypeScript file from disk
 */
export async function parseFileAtPath(filePath: string): Promise<ExportInfo[]> {
	const { readFile } = await import("node:fs/promises");
	const content = await readFile(filePath, "utf-8");
	return parseFile(content, filePath);
}
