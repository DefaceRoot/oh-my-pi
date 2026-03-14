/**
 * Template Variables System
 *
 * Provides variable substitution for documentation templates.
 * Supports common variables like {{version}}, {{date}}, {{author}}
 * and allows custom variables to be defined.
 */

/**
 * Built-in variable names that are always available
 */
export type BuiltInVariable = "version" | "date" | "time" | "year" | "author" | "timestamp";

/**
 * Variable map for custom variables
 */
export interface VariableMap {
	[key: string]: string | number | (() => string);
}

/**
 * Configuration for template variable substitution
 */
export interface TemplateVariablesOptions {
	/** Built-in variables to include (default: all) */
	includeBuiltIn?: BuiltInVariable[];
	/** Custom variables to add */
	custom?: VariableMap;
	/** Package version (for {{version}}) */
	version?: string;
	/** Author name (for {{author}}) */
	author?: string;
	/** Date format for {{date}} (default: 'YYYY-MM-DD') */
	dateFormat?: string;
	/** Locale for date formatting (default: 'en-US') */
	locale?: string;
}

/**
 * Compiled variable resolver with cached values
 */
export interface VariableResolver {
	/** Resolve a variable value by name */
	resolve(name: string): string;
	/** Substitute all variables in a template string */
	substitute(template: string): string;
	/** Get all available variable names */
	getVariableNames(): string[];
}

/**
 * Format date according to specified format string
 */
function formatDate(date: Date, format: string, _locale: string): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");

	return format
		.replace("YYYY", String(year))
		.replace("YY", String(year).slice(-2))
		.replace("MM", month)
		.replace("DD", day)
		.replace("HH", hours)
		.replace("mm", minutes)
		.replace("ss", seconds);
}

/**
 * Create a variable resolver for template substitution
 */
export function createVariables(options: TemplateVariablesOptions = {}): VariableResolver {
	const {
		includeBuiltIn = ["version", "date", "time", "year", "author", "timestamp"],
		custom = {},
		version = "1.0.0",
		author = "Anonymous",
		dateFormat = "YYYY-MM-DD",
		locale = "en-US",
	} = options;

	const now = new Date();

	// Build variable map
	const variables = new Map<string, string | (() => string)>();

	// Built-in variables
	if (includeBuiltIn.includes("version")) {
		variables.set("version", version);
	}

	if (includeBuiltIn.includes("date")) {
		variables.set("date", formatDate(now, dateFormat, locale));
	}

	if (includeBuiltIn.includes("time")) {
		variables.set("time", formatDate(now, "HH:mm:ss", locale));
	}

	if (includeBuiltIn.includes("year")) {
		variables.set("year", String(now.getFullYear()));
	}

	if (includeBuiltIn.includes("author")) {
		variables.set("author", author);
	}

	if (includeBuiltIn.includes("timestamp")) {
		variables.set("timestamp", String(now.getTime()));
	}

	// Custom variables
	for (const [key, value] of Object.entries(custom)) {
		variables.set(key, value);
	}

	return {
		resolve(name: string): string {
			const value = variables.get(name);
			if (value === undefined) {
				return "";
			}
			return typeof value === "function" ? value() : String(value);
		},

		substitute(template: string): string {
			// Match {{variableName}} patterns
			return template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
				const value = this.resolve(name);
				return value !== "" ? value : match;
			});
		},

		getVariableNames(): string[] {
			return Array.from(variables.keys());
		},
	};
}

/**
 * Quick substitute function for one-off template replacements
 */
export function substitute(template: string, options: TemplateVariablesOptions = {}): string {
	const resolver = createVariables(options);
	return resolver.substitute(template);
}

/**
 * Extract all variable names from a template string
 */
export function extractVariables(template: string): string[] {
	const matches = template.match(/\{\{(\w+)\}\}/g);
	if (!matches) {
		return [];
	}
	return matches.map(match => match.slice(2, -2));
}

/**
 * Validate that all variables in a template are available
 */
export function validateTemplate(
	template: string,
	resolver: VariableResolver,
): {
	valid: boolean;
	missing: string[];
} {
	const required = extractVariables(template);
	const available = new Set(resolver.getVariableNames());
	const missing = required.filter(v => !available.has(v));

	return {
		valid: missing.length === 0,
		missing,
	};
}
