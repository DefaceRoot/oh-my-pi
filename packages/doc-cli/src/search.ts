/**
 * Advanced Search for Documentation
 *
 * Provides:
 * - Fuzzy search matching
 * - Filter by type/package
 * - Search within code examples
 * - Recent searches history
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	APIMember,
	CodeBlock,
	DocumentationOptions,
	DocumentationSection,
	ExampleBlock,
	PackageDependency,
} from "./generator.js";

/**
 * Search filters for narrowing results
 */
export interface SearchFilters {
	/** Filter by content type */
	type?: ("section" | "api" | "dependency" | "example")[];
	/** Filter by package name (for dependencies) */
	packageName?: string;
	/** Filter by dependency type */
	dependencyType?: ("production" | "development" | "peer")[];
	/** Search within code blocks only */
	codeOnly?: boolean;
	/** Include code examples in search */
	includeCode?: boolean;
}

/**
 * Search options
 */
export interface SearchOptions {
	/** Maximum number of results to return */
	limit?: number;
	/** Minimum fuzzy match score (0-1) */
	minScore?: number;
	/** Filters to apply */
	filters?: SearchFilters;
	/** Whether to save this search to history */
	saveToHistory?: boolean;
}

/**
 * Search result with metadata
 */
export interface SearchResult<T = unknown> {
	/** The matched item */
	item: T;
	/** Match score (0-1, higher is better) */
	score: number;
	/** Matched field name */
	matchedField: string;
	/** Type of the matched item */
	type: "section" | "api" | "dependency" | "example";
}

/**
 * Recent search entry
 */
export interface RecentSearch {
	/** The search query */
	query: string;
	/** Timestamp of the search */
	timestamp: number;
	/** Number of results found */
	resultCount: number;
	/** Filters used */
	filters?: SearchFilters;
}

/**
 * History storage options
 */
export interface HistoryOptions {
	/** Maximum number of searches to keep */
	maxEntries?: number;
	/** Custom history file path */
	historyPath?: string;
}

// Default history file location
const DEFAULT_HISTORY_DIR = join(homedir(), ".doc-cli");
const DEFAULT_HISTORY_FILE = join(DEFAULT_HISTORY_DIR, "search-history.json");

/**
 * Calculate fuzzy match score using simple character distance
 * Returns a score between 0 (no match) and 1 (perfect match)
 */
export function fuzzyMatch(pattern: string, text: string): number {
	const p = pattern.toLowerCase();
	const t = text.toLowerCase();

	// Perfect match
	if (t.includes(p)) {
		return 1.0;
	}

	// Calculate character distance score
	let patternIdx = 0;
	let matches = 0;
	let lastMatchIdx = -1;

	for (let i = 0; i < t.length && patternIdx < p.length; i++) {
		if (t[i] === p[patternIdx]) {
			matches++;
			// Prefer consecutive matches
			if (lastMatchIdx === i - 1) {
				matches += 0.5;
			}
			lastMatchIdx = i;
			patternIdx++;
		}
	}

	if (patternIdx === 0) {
		return 0; // No match at all
	}

	// Score based on pattern coverage and proximity
	const coverageScore = matches / p.length;
	const positionScore = 1 - (lastMatchIdx / t.length) * 0.3; // Prefer earlier matches
	return Math.min(1.0, coverageScore * positionScore);
}

/**
 * Find best fuzzy match across multiple fields
 */
export function findBestMatch(pattern: string, item: Record<string, unknown>): { score: number; field: string } {
	let bestScore = 0;
	let bestField = "";

	for (const [key, value] of Object.entries(item)) {
		if (typeof value === "string") {
			const score = fuzzyMatch(pattern, value);
			if (score > bestScore) {
				bestScore = score;
				bestField = key;
			}
		}
	}

	return { score: bestScore, field: bestField };
}

/**
 * Search documentation sections
 */
export function searchSections(
	query: string,
	sections: DocumentationSection[],
	minScore: number,
): Array<SearchResult<DocumentationSection>> {
	const results: Array<SearchResult<DocumentationSection>> = [];

	for (const section of sections) {
		const { score, field } = findBestMatch(query, section);
		if (score >= minScore) {
			results.push({
				item: section,
				score,
				matchedField: field,
				type: "section",
			});
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Search API members
 */
export function searchAPIMembers(
	query: string,
	apiMembers: APIMember[],
	minScore: number,
): Array<SearchResult<APIMember>> {
	const results: Array<SearchResult<APIMember>> = [];

	for (const member of apiMembers) {
		const { score, field } = findBestMatch(query, member);
		if (score >= minScore) {
			results.push({
				item: member,
				score,
				matchedField: field,
				type: "api",
			});
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Search package dependencies
 */
export function searchDependencies(
	query: string,
	dependencies: PackageDependency[],
	minScore: number,
): Array<SearchResult<PackageDependency>> {
	const results: Array<SearchResult<PackageDependency>> = [];

	for (const dep of dependencies) {
		const { score, field } = findBestMatch(query, dep);
		if (score >= minScore) {
			results.push({
				item: dep,
				score,
				matchedField: field,
				type: "dependency",
			});
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Search code examples
 */
export function searchExamples(
	query: string,
	examples: ExampleBlock[],
	minScore: number,
): Array<SearchResult<ExampleBlock>> {
	const results: Array<SearchResult<ExampleBlock>> = [];

	for (const example of examples) {
		// Search in target name, caption, source
		const { score, field } = findBestMatch(query, example);

		// Also search within code content
		const codeScore = fuzzyMatch(query, example.code);
		const bestScore = Math.max(score, codeScore);
		const bestField = codeScore > score ? "code" : field;

		if (bestScore >= minScore) {
			results.push({
				item: example,
				score: bestScore,
				matchedField: bestField,
				type: "example",
			});
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Search within code blocks of sections
 */
export function searchCodeBlocks(
	query: string,
	sections: DocumentationSection[],
	minScore: number,
): Array<SearchResult<{ section: DocumentationSection; codeBlock: CodeBlock }>> {
	const results: Array<SearchResult<{ section: DocumentationSection; codeBlock: CodeBlock }>> = [];

	for (const section of sections) {
		if (!section.codeBlocks) continue;

		for (const codeBlock of section.codeBlocks) {
			// Search in caption
			const captionScore = codeBlock.caption ? fuzzyMatch(query, codeBlock.caption) : 0;
			// Search in code content
			const codeScore = fuzzyMatch(query, codeBlock.code);

			const bestScore = Math.max(captionScore, codeScore);
			const bestField = codeScore > captionScore ? "code" : "caption";

			if (bestScore >= minScore) {
				results.push({
					item: { section, codeBlock },
					score: bestScore,
					matchedField: bestField,
					type: "section", // Code blocks belong to sections
				});
			}
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Apply filters to search results
 */
export function applyFilters<T>(results: Array<SearchResult<T>>, filters: SearchFilters): Array<SearchResult<T>> {
	let filtered = results;

	// Filter by type
	if (filters.type && filters.type.length > 0) {
		filtered = filtered.filter(r => filters.type!.includes(r.type));
	}

	// Filter by package name (for dependencies)
	if (filters.packageName) {
		filtered = filtered.filter(r => {
			if (r.type === "dependency") {
				const dep = r.item as PackageDependency;
				return dep.name.includes(filters.packageName!);
			}
			return true;
		});
	}

	// Filter by dependency type
	if (filters.dependencyType && filters.dependencyType.length > 0) {
		filtered = filtered.filter(r => {
			if (r.type === "dependency") {
				const dep = r.item as PackageDependency;
				return filters.dependencyType!.includes(dep.type);
			}
			return true;
		});
	}

	// Code only filter
	if (filters.codeOnly) {
		filtered = filtered.filter(r => r.matchedField === "code");
	}

	return filtered;
}

/**
 * Main search function
 */
export function search(
	query: string,
	documentation: DocumentationOptions,
	options: SearchOptions = {},
): Array<SearchResult> {
	const { limit = 50, minScore = 0.3, filters = {}, saveToHistory = true } = options;

	const results: Array<SearchResult> = [];

	// Search sections
	if (!filters.codeOnly) {
		if (!filters.type || filters.type.includes("section")) {
			const sectionResults = searchSections(query, documentation.sections || [], minScore);
			results.push(...sectionResults);
		}

		// Search API members
		if (!filters.type || filters.type.includes("api")) {
			const apiResults = searchAPIMembers(query, documentation.apiMembers || [], minScore);
			results.push(...apiResults);
		}

		// Search dependencies
		if (!filters.type || filters.type.includes("dependency")) {
			const depResults = searchDependencies(query, documentation.dependencies || [], minScore);
			results.push(...depResults);
		}

		// Search examples
		if (!filters.type || filters.type.includes("example")) {
			const exampleResults = searchExamples(query, documentation.examples || [], minScore);
			results.push(...exampleResults);
		}
	}

	// Search within code blocks if requested
	if (filters.includeCode || filters.codeOnly) {
		const codeBlockResults = searchCodeBlocks(query, documentation.sections || [], minScore);
		results.push(...codeBlockResults);
	}

	// Apply filters
	const filtered = applyFilters(results, filters);

	// Sort by score and limit
	const finalResults = filtered.sort((a, b) => b.score - a.score).slice(0, limit);

	// Save to history
	if (saveToHistory) {
		saveSearchToHistory(query, finalResults.length, filters);
	}

	return finalResults;
}

/**
 * Load search history from file
 */
export function loadSearchHistory(historyPath?: string): RecentSearch[] {
	const path = historyPath || DEFAULT_HISTORY_FILE;

	if (!existsSync(path)) {
		return [];
	}

	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as RecentSearch[];
	} catch {
		return [];
	}
}

/**
 * Save search history to file
 */
export function saveSearchToHistory(
	query: string,
	resultCount: number,
	filters?: SearchFilters,
	options?: HistoryOptions,
): void {
	const { maxEntries = 100, historyPath } = options || {};
	const path = historyPath || DEFAULT_HISTORY_FILE;

	// Ensure directory exists
	const dir = path.substring(0, path.lastIndexOf("/"));
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Load existing history
	const history = loadSearchHistory(path);

	// Add new search entry
	const entry: RecentSearch = {
		query,
		timestamp: Date.now(),
		resultCount,
		filters,
	};

	// Add to beginning and trim
	const newHistory = [entry, ...history].slice(0, maxEntries);

	// Save
	try {
		writeFileSync(path, JSON.stringify(newHistory, null, 2), "utf-8");
	} catch (error) {
		console.error("Failed to save search history:", error);
	}
}

/**
 * Get recent searches
 */
export function getRecentSearches(limit = 10, historyPath?: string): RecentSearch[] {
	const history = loadSearchHistory(historyPath);
	return history.slice(0, limit);
}

/**
 * Clear search history
 */
export function clearSearchHistory(historyPath?: string): void {
	const path = historyPath || DEFAULT_HISTORY_FILE;
	try {
		if (existsSync(path)) {
			writeFileSync(path, "[]", "utf-8");
		}
	} catch (error) {
		console.error("Failed to clear search history:", error);
	}
}

/**
 * Autocomplete suggestion entry
 */
export interface AutocompleteSuggestion {
	/** The suggested query text */
	query: string;
	/** Type of suggestion */
	type: "recent" | "popular";
	/** Frequency score for ranking */
	score: number;
	/** Last used timestamp (for recent searches) */
	timestamp?: number;
}

/**
 * Autocomplete options
 */
export interface AutocompleteOptions {
	/** Maximum number of suggestions to return */
	limit?: number;
	/** Minimum fuzzy match score (0-1) */
	minScore?: number;
	/** Include recent searches from history */
	includeRecent?: boolean;
	/** Include popular queries */
	includePopular?: boolean;
	/** Custom history file path */
	historyPath?: string;
}

// Default popular queries based on common documentation searches
const DEFAULT_POPULAR_QUERIES = [
	"installation",
	"getting started",
	"api reference",
	"configuration",
	"examples",
	"tutorial",
	"troubleshooting",
	"authentication",
	"errors",
	"types",
	"functions",
	"classes",
	"methods",
	"properties",
	"events",
	"dependencies",
	"plugins",
	"cli commands",
	"environment variables",
	"best practices",
];

/**
 * Get autocomplete suggestions for a partial search query
 *
 * Combines recent searches from history with popular queries,
 * ranking by relevance and frequency.
 */
export function getAutocompleteSuggestions(
	partialQuery: string,
	options: AutocompleteOptions = {},
): AutocompleteSuggestion[] {
	const { limit = 8, minScore = 0.2, includeRecent = true, includePopular = true, historyPath } = options;

	const suggestions: AutocompleteSuggestion[] = [];
	const partial = partialQuery.trim().toLowerCase();

	// Add recent searches from history
	if (includeRecent) {
		const recentSearches = loadSearchHistory(historyPath);

		for (const search of recentSearches) {
			// Skip if query is same as partial (user is typing it)
			if (search.query.toLowerCase() === partial) {
				continue;
			}

			// Calculate relevance score
			let score = 0.5; // Base score for being recent

			// Boost if matches partial query
			if (partial.length > 0) {
				const matchScore = fuzzyMatch(partial, search.query);
				if (matchScore >= minScore) {
					score += matchScore * 0.5;
				} else {
					// Don't include if it doesn't match at all
					continue;
				}
			}

			// Decay score based on age (older searches get lower score)
			const ageInDays = (Date.now() - search.timestamp) / (1000 * 60 * 60 * 24);
			const ageDecay = Math.max(0, 1 - ageInDays / 30); // Decay over 30 days
			score *= ageDecay;

			// Boost if search had many results (likely useful)
			if (search.resultCount > 0) {
				score += Math.min(0.2, search.resultCount * 0.01);
			}

			suggestions.push({
				query: search.query,
				type: "recent",
				score,
				timestamp: search.timestamp,
			});
		}
	}

	// Add popular queries
	if (includePopular) {
		for (const query of DEFAULT_POPULAR_QUERIES) {
			// Skip if already in recent searches (deduplicate)
			if (suggestions.some(s => s.query.toLowerCase() === query.toLowerCase())) {
				continue;
			}

			let score = 0.3; // Base score for being popular

			// Boost if matches partial query
			if (partial.length > 0) {
				const matchScore = fuzzyMatch(partial, query);
				if (matchScore >= minScore) {
					score += matchScore * 0.7;
				} else {
					// Don't include if it doesn't match at all
					continue;
				}
			}

			suggestions.push({
				query,
				type: "popular",
				score,
			});
		}
	}

	// Sort by score (highest first) and limit
	return suggestions.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Get popular queries for autocomplete
 *
 * Returns a static list of popular documentation search queries.
 */
export function getPopularQueries(limit = 20): string[] {
	return DEFAULT_POPULAR_QUERIES.slice(0, limit);
}

/**
 * Update suggestion frequency based on user selection
 *
 * When a user selects an autocomplete suggestion, this function
 * can be called to boost that query's popularity.
 * For now, this is a no-op but exists for future enhancements.
 */
export function recordSuggestionSelection(_query: string, _historyPath?: string): void {
	// For future enhancement: could maintain a frequency map of selected suggestions
	// For now, we rely on search history which is already updated when a search is performed
	// This is a placeholder for potential future features
	return;
}
