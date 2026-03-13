export interface PackageInfo {
	name: string;
	path: string;
	version: string;
	exports: ExportInfo[];
}

export interface ExportInfo {
	name: string;
	type: "function" | "class" | "interface" | "type" | "const";
	filePath: string;
	lineNumber: number;
	jsdoc?: string;
}
