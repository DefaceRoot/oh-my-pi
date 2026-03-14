/**
 * Confluence import integration
 *
 * Imports documentation content from Confluence Cloud API and converts it
 * into structured format for use with doc-cli documentation generation tools.
 */

import type { DocumentationSection } from "../generator.js";

/**
 * Confluence API authentication options
 */
export interface ConfluenceAuthOptions {
	/** Confluence API token (generate from https://id.atlassian.com/manage-profile/security/api-tokens) */
	apiToken: string;
	/** Confluence user email */
	email: string;
	/** Confluence instance URL (e.g., https://your-domain.atlassian.net) */
	baseUrl: string;
}

/**
 * Confluence content import options
 */
export interface ConfluenceImportOptions {
	/** Authentication credentials */
	auth: ConfluenceAuthOptions;
	/** Confluence space key (e.g., 'DOC', 'ENG') */
	spaceKey: string;
	/** Specific page IDs to import (if not provided, imports all pages) */
	pageIds?: string[];
	/** Include child pages recursively */
	includeChildren?: boolean;
	/** Maximum depth for child page traversal (default: 2) */
	maxDepth?: number;
	/** Filter pages by label (optional) */
	label?: string;
	/** Expand macros and convert to markdown (default: true) */
	expandMacros?: boolean;
}

/**
 * Confluence page data structure
 */
interface ConfluencePage {
	id: string;
	title: string;
	content: string;
	version: number;
	author: string;
	createdAt: string;
	updatedAt: string;
	url: string;
	labels: string[];
}

/**
 * Confluence API response structures
 */
interface ConfluencePageResponse {
	id: string;
	title: string;
	version?: { number: number };
	author?: { displayName: string; email: string };
	created?: string;
	["_expandable"]?: {
		children?: string;
		container?: string;
	};
	body?: {
		view?: {
			value: string;
			representation: string;
		};
		storage?: {
			value: string;
			representation: string;
		};
	};
	metadata?: {
		labels?: {
			results?: Array<{ name: string; prefix: string }>;
		};
	};
	["_links"]?: {
		webui: string;
		tinyui: string;
	};
}

interface ConfluenceChildrenResponse {
	results: Array<{
		id: string;
		title: string;
	}>;
	size?: number;
}

/**
 * Import documentation from Confluence
 *
 * Fetches pages from Confluence and converts them to DocumentationSection format
 * for use with doc-cli documentation generation tools.
 *
 * @param options - Import configuration including authentication and content selection
 * @returns Promise resolving to array of DocumentationSection objects
 *
 * @example
 * ```typescript
 * const sections = await importFromConfluence({
 *   auth: {
 *     email: 'user@example.com',
 *     apiToken: 'your-api-token',
 *     baseUrl: 'https://your-domain.atlassian.net'
 *   },
 *   spaceKey: 'DOC',
 *   includeChildren: true,
 *   maxDepth: 2
 * });
 * ```
 */
export async function importFromConfluence(options: ConfluenceImportOptions): Promise<DocumentationSection[]> {
	const { auth, spaceKey, pageIds, includeChildren = false, maxDepth = 2, label, expandMacros = true } = options;

	const pages: ConfluencePage[] = [];

	try {
		// Fetch pages based on configuration
		if (pageIds && pageIds.length > 0) {
			// Import specific pages
			for (const pageId of pageIds) {
				const page = await fetchConfluencePage(auth, pageId, expandMacros);

				// Apply label filter if specified
				if (label && !page.labels.includes(label)) {
					continue;
				}

				pages.push(page);

				if (includeChildren) {
					const children = await fetchChildPages(auth, pageId, maxDepth - 1, label, expandMacros);
					pages.push(...children);
				}
			}
		} else {
			// Import all pages from space
			const spacePages = await fetchAllPagesFromSpace(auth, spaceKey, label, expandMacros);
			pages.push(...spacePages);
		}

		// Convert Confluence pages to DocumentationSection format
		return pages.map(page => ({
			title: page.title,
			content: page.content,
			level: 2,
		}));
	} catch (error) {
		throw new Error(`Failed to import from Confluence: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

/**
 * Fetch a single Confluence page with content
 */
async function fetchConfluencePage(
	auth: ConfluenceAuthOptions,
	pageId: string,
	expandMacros: boolean,
): Promise<ConfluencePage> {
	const { apiToken, email, baseUrl } = auth;

	// Build URL with appropriate expansions
	const expandParams = ["version", "author", "metadata.labels"];
	if (expandMacros) {
		expandParams.push("body.storage");
	} else {
		expandParams.push("body.view");
	}

	const url = `${baseUrl}/wiki/rest/api/content/${pageId}?expand=${expandParams.join(",")}`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Basic ${btoa(`${email}:${apiToken}`)}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch Confluence page ${pageId}: ${response.statusText} (${response.status})`);
	}

	const data: ConfluencePageResponse = await response.json();
	return convertToConfluencePage(data, baseUrl);
}

/**
 * Fetch child pages recursively
 */
async function fetchChildPages(
	auth: ConfluenceAuthOptions,
	parentPageId: string,
	remainingDepth: number,
	labelFilter?: string,
	expandMacros = true,
): Promise<ConfluencePage[]> {
	if (remainingDepth <= 0) return [];

	const { apiToken, email, baseUrl } = auth;
	const url = `${baseUrl}/wiki/rest/api/content/${parentPageId}/child/page?limit=50`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Basic ${btoa(`${email}:${apiToken}`)}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch child pages for ${parentPageId}: ${response.statusText}`);
	}

	const data: ConfluenceChildrenResponse = await response.json();
	const pages: ConfluencePage[] = [];

	for (const child of data.results) {
		try {
			const page = await fetchConfluencePage(auth, child.id, expandMacros);

			// Apply label filter if specified
			if (labelFilter && !page.labels.includes(labelFilter)) {
				continue;
			}

			pages.push(page);

			const grandchildren = await fetchChildPages(auth, child.id, remainingDepth - 1, labelFilter, expandMacros);
			pages.push(...grandchildren);
		} catch (error) {
			// Continue with other pages if one fails
			console.warn(`Failed to fetch child page ${child.id}:`, error);
		}
	}

	return pages;
}

/**
 * Fetch all pages from a Confluence space
 */
async function fetchAllPagesFromSpace(
	auth: ConfluenceAuthOptions,
	spaceKey: string,
	labelFilter?: string,
	expandMacros = true,
): Promise<ConfluencePage[]> {
	const { apiToken, email, baseUrl } = auth;
	const pages: ConfluencePage[] = [];
	let start = 0;
	const limit = 50;

	while (true) {
		const expandParams = ["version", "author", "metadata.labels"];
		if (expandMacros) {
			expandParams.push("body.storage");
		} else {
			expandParams.push("body.view");
		}

		const url = `${baseUrl}/wiki/rest/api/content?spaceKey=${spaceKey}&limit=${limit}&start=${start}&expand=${expandParams.join(",")}`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Basic ${btoa(`${email}:${apiToken}`)}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch pages from space ${spaceKey}: ${response.statusText}`);
		}

		const data: { results: ConfluencePageResponse[]; size: number } = await response.json();

		for (const pageData of data.results) {
			const page = convertToConfluencePage(pageData, baseUrl);

			// Apply label filter if specified
			if (labelFilter && !page.labels.includes(labelFilter)) {
				continue;
			}

			pages.push(page);
		}

		if (pages.length >= data.size) break;
		start += limit;
	}

	return pages;
}

/**
 * Convert Confluence API response to internal page format
 */
function convertToConfluencePage(data: ConfluencePageResponse, baseUrl: string): ConfluencePage {
	// Extract labels
	const labels = data.metadata?.labels?.results?.map(l => l.name) || [];

	// Get content from storage or view format
	const contentBody = data.body?.storage?.value || data.body?.view?.value || "";

	return {
		id: data.id,
		title: data.title,
		content: convertConfluenceContentToMarkdown(contentBody),
		version: data.version?.number || 1,
		author: data.author?.displayName || data.author?.email || "Unknown",
		createdAt: data.created || new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		url: data._links?.webui ? `${baseUrl}${data._links.webui}` : `${baseUrl}/wiki/pages/${data.id}`,
		labels,
	};
}

/**
 * Convert Confluence storage format content to markdown
 *
 * This is a basic implementation that handles common Confluence elements.
 * For production use, consider using a dedicated library like 'confluence-to-markdown'
 * for more comprehensive conversion.
 */
function convertConfluenceContentToMarkdown(content: string): string {
	if (!content) return "";

	// Basic conversion of Confluence storage format to markdown
	let markdown = content;

	// Convert headings
	markdown = markdown.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n");
	markdown = markdown.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n");
	markdown = markdown.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n");
	markdown = markdown.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n");
	markdown = markdown.replace(/<h5[^>]*>(.*?)<\/h5>/gi, "##### $1\n");
	markdown = markdown.replace(/<h6[^>]*>(.*?)<\/h6>/gi, "###### $1\n");

	// Convert bold and italic
	markdown = markdown.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
	markdown = markdown.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
	markdown = markdown.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
	markdown = markdown.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");

	// Convert links
	markdown = markdown.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");

	// Convert code blocks
	markdown = markdown.replace(/<pre[^>]*><code[^>]*>(.*?)<\/code><\/pre>/gis, "```\n$1\n```");
	markdown = markdown.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");

	// Convert unordered lists
	markdown = markdown.replace(/<ul[^>]*>/gi, "");
	markdown = markdown.replace(/<\/ul>/gi, "\n");
	markdown = markdown.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");

	// Convert ordered lists
	markdown = markdown.replace(/<ol[^>]*>/gi, "");
	markdown = markdown.replace(/<\/ol>/gi, "\n");
	markdown = markdown.replace(/<li[^>]*>(.*?)<\/li>/gi, "1. $1\n");

	// Convert paragraphs
	markdown = markdown.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");

	// Convert line breaks
	markdown = markdown.replace(/<br\s*\/?>/gi, "\n");

	// Remove remaining HTML tags
	markdown = markdown.replace(/<[^>]+>/g, "");

	// Clean up excessive whitespace
	markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

	return markdown;
}

/**
 * Test connection to Confluence API
 *
 * Useful for verifying authentication credentials before attempting import.
 *
 * @param auth - Confluence authentication options
 * @returns Promise resolving to true if connection successful, false otherwise
 */
export async function testConfluenceConnection(auth: ConfluenceAuthOptions): Promise<boolean> {
	try {
		const { apiToken, email, baseUrl } = auth;
		const url = `${baseUrl}/wiki/rest/api/user/current`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Basic ${btoa(`${email}:${apiToken}`)}`,
				Accept: "application/json",
			},
		});

		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Get available spaces for the authenticated user
 *
 * Useful for discovering available spaces before importing.
 *
 * @param auth - Confluence authentication options
 * @returns Promise resolving to array of space objects with key and name
 */
export async function getConfluenceSpaces(auth: ConfluenceAuthOptions): Promise<Array<{ key: string; name: string }>> {
	const { apiToken, email, baseUrl } = auth;
	const spaces: Array<{ key: string; name: string }> = [];
	let start = 0;
	const limit = 50;

	while (true) {
		const url = `${baseUrl}/wiki/rest/api/space?limit=${limit}&start=${start}`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Basic ${btoa(`${email}:${apiToken}`)}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch spaces: ${response.statusText}`);
		}

		const data: {
			results: Array<{ key: string; name: string }>;
			size: number;
		} = await response.json();

		for (const space of data.results) {
			spaces.push({ key: space.key, name: space.name });
		}

		if (spaces.length >= data.size) break;
		start += limit;
	}

	return spaces;
}
