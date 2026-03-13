export interface PackageInfo {
	name: string;
	path: string;
	version: string;
	description?: string;
	exports: ExportInfo[];
}

export interface ExportInfo {
	name: string;
	type: "function" | "class" | "interface" | "type" | "const" | "enum";
	filePath: string;
	lineNumber: number;
	jsdoc?: string;
	isExported: boolean;
}
