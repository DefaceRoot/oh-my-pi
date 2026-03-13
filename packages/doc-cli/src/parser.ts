import * as fs from 'fs';
import * as path from 'path';
import { ExportInfo } from './types';

export function parseExports(filePath: string): ExportInfo[] {
	const exports: ExportInfo[] = [];
	
	if (!fs.existsSync(filePath)) {
		return exports;
	}

	const content = fs.readFileSync(filePath, 'utf-8');
	const lines = content.split('\n');

	const patterns = {
		function: /export\s+(async\s+)?function\s+(\w+)/,
		class: /export\s+class\s+(\w+)/,
		interface: /export\s+interface\s+(\w+)/,
		type: /export\s+type\s+(\w+)/,
		const: /export\s+const\s+(\w+)/,
		enum: /export\s+enum\s+(\w+)/
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = i + 1;

		for (const [type, pattern] of Object.entries(patterns)) {
			const match = line.match(pattern);
			if (match) {
				const name = match[2] || match[1];
				const jsdoc = extractJSDoc(lines, i);

				exports.push({
					name,
					type: type as ExportInfo['type'],
					filePath,
					lineNumber,
					jsdoc: jsdoc || undefined,
					isExported: true
				});
			}
		}
	}

	return exports;
}

function extractJSDoc(lines: string[], exportLineIndex: number): string | null {
	const jsdocLines: string[] = [];
	let currentLine = exportLineIndex - 1;

	// Skip empty lines between JSDoc and export
	while (currentLine >= 0 && lines[currentLine].trim() === '') {
		currentLine--;
	}

	// Check if we have a JSDoc comment
	if (currentLine < 0 || !lines[currentLine].trim().endsWith('*/')) {
		return null;
	}

	// Extract JSDoc content
	while (currentLine >= 0) {
		const line = lines[currentLine];
		jsdocLines.unshift(line);

		if (line.trim().startsWith('/**')) {
			break;
		}
		currentLine--;
	}

	if (jsdocLines.length === 0) {
		return null;
	}

	// Clean up JSDoc formatting
	const jsdocText = jsdocLines
		.map(l => l
			.replace(/^\s*\/\*\*/, '')
			.replace(/\*\/$/, '')
			.replace(/^\s*\*\s?/, '')
		)
		.join('\n')
		.trim();

	return jsdocText;
}
