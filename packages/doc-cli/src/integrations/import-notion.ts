/**
 * Notion import integration
 *
 * Imports documentation content from Notion API and converts it
 * into structured format for use with doc-cli documentation generation tools.
 */

import type { DocumentationSection } from "../generator.js";

/**
 * Notion API authentication options
 */
export interface NotionAuthOptions {
	/** Notion API integration token (generate from https://www.notion.so/my-integrations) */
	apiKey: string;
	/** Notion API version (default: '2022-06-28') */
	apiVersion?: string;
}

/**
 * Notion content import options
 */
export interface NotionImportOptions {
	/** Authentication credentials */
	auth: NotionAuthOptions;
	/** Notion database IDs to import pages from */
	databaseIds?: string[];
	/** Specific page IDs to import (if not provided, imports from databases) */
	pageIds?: string[];
	/** Include child pages recursively */
	includeChildren?: boolean;
	/** Maximum depth for child page traversal (default: 2) */
	maxDepth?: boolean;
	/** Filter pages by property value (optional) */
	filterProperty?: string;
	/** Filter value to match */
	filterValue?: string;
	/** Convert Notion blocks to markdown (default: true) */
	convertToMarkdown?: boolean;
}

/**
 * Notion page data structure
 */
interface NotionPage {
	id: string;
	title: string;
	content: string;
	createdTime: string;
	editedTime: string;
	url: string;
	icon?: string;
	cover?: string;
}

/**
 * Notion API response structures
 */
interface NotionPageResponse {
	id: string;
	created_time: string;
	last_edited_time: string;
	icon?: { type: string; emoji?: string };
	cover?: { type: string; external?: { url: string } };
	url: string;
	parent: {
		type: string;
		database_id?: string;
		page_id?: string;
	};
	properties?: Record<string, any>;
	archived: boolean;
}

interface NotionBlockResponse {
	object: string;
	results: NotionBlock[];
	next_cursor?: string;
	has_more: boolean;
}

interface NotionBlock {
	id: string;
	type: string;
	paragraph?: {
		rich_text: Array<{ type: string; text: { content: string } }>;
	};
	heading_1?: {
		rich_text: Array<{ type: string; text: { content: string } }>;
	};
	heading_2?: {
		rich_text: Array<{ type: string; text: { content: string } }>;
	};
	heading_3?: {
		rich_text: Array<{ type: string; text: { content: string } }>;
	};
	bulleted_list_item?: {
		rich_text: Array<{ type: string; text: { content: string } }>;
	};
	numbered_list_item?: {
		rich_text: Array<{ type: string; text: { content: string } }>;
	};
	quote?: {
		rich_text: Array<{ type: string; text: { content: string } }>;
	};
	code?: {
		rich_text: Array<{ type: string; text: { content: string } }>;
		language?: string;
	};
	callout?: {
		rich_text: Array<{ type: string; text: { content: string } }>;
	};
	divider?: Record<never, never>;
}

interface NotionDatabaseResponse {
	object: string;
	results: NotionPageResponse[];
	next_cursor?: string;
	has_more: boolean;
}

/**
 * Import documentation from Notion
 *
 * Fetches pages from Notion and converts them to DocumentationSection format
 * for use with doc-cli documentation generation tools.
 *
 * @param options - Import configuration including authentication and content selection
 * @returns Promise resolving to array of DocumentationSection objects
 *
 * @example
 * ```typescript
 * const sections = await importFromNotion({
 *   auth: {
 *     apiKey: 'your-notion-api-key'
 *   },
 *   databaseIds: ['database-id-1', 'database-id-2'],
 *   includeChildren: true,
 *   maxDepth: 2
 * });
 * ```
 */
export async function importFromNotion(options: NotionImportOptions): Promise<DocumentationSection[]> {
	const {
		auth,
		databaseIds,
		pageIds,
		includeChildren = false,
		maxDepth = 2,
		filterProperty,
		filterValue,
		convertToMarkdown = true,
	} = options;

	const pages: NotionPage[] = [];

	try {
		// Fetch pages based on configuration
		if (pageIds && pageIds.length > 0) {
			// Import specific pages
			for (const pageId of pageIds) {
				const page = await fetchNotionPage(auth, pageId, convertToMarkdown);

				// Apply property filter if specified
				if (filterProperty && filterValue) {
					const pageData = await fetchNotionPageRaw(auth, pageId);
					const propValue = pageData.properties?.[filterProperty];
					if (!propValue || JSON.stringify(propValue).toLowerCase().includes(filterValue.toLowerCase())) {
						continue;
					}
				}

				pages.push(page);

				if (includeChildren) {
					const children = await fetchChildPages(auth, pageId, maxDepth - 1, convertToMarkdown);
					pages.push(...children);
				}
			}
		} else if (databaseIds && databaseIds.length > 0) {
			// Import pages from databases
			for (const databaseId of databaseIds) {
				const dbPages = await fetchPagesFromDatabase(
					auth,
					databaseId,
					filterProperty,
					filterValue,
					convertToMarkdown,
				);
				pages.push(...dbPages);

				if (includeChildren) {
					for (const page of dbPages) {
						const children = await fetchChildPages(auth, page.id, maxDepth - 1, convertToMarkdown);
						pages.push(...children);
					}
				}
			}
		} else {
			throw new Error("Either pageIds or databaseIds must be provided");
		}

		// Convert Notion pages to DocumentationSection format
		return pages.map(page => ({
			title: page.title,
			content: page.content,
			level: 2,
		}));
	} catch (error) {
		throw new Error(`Failed to import from Notion: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

/**
 * Fetch a single Notion page with content
 */
async function fetchNotionPage(
	auth: NotionAuthOptions,
	pageId: string,
	convertToMarkdown: boolean,
): Promise<NotionPage> {
	const pageData = await fetchNotionPageRaw(auth, pageId);
	const content = await fetchNotionPageContent(auth, pageId, convertToMarkdown);

	return {
		id: pageData.id,
		title: extractTitleFromPage(pageData),
		content,
		createdTime: pageData.created_time,
		editedTime: pageData.last_edited_time,
		url: pageData.url,
		icon: pageData.icon?.emoji,
		cover: pageData.cover?.external?.url,
	};
}

/**
 * Fetch raw Notion page data
 */
async function fetchNotionPageRaw(auth: NotionAuthOptions, pageId: string): Promise<NotionPageResponse> {
	const { apiKey, apiVersion = "2022-06-28" } = auth;
	const url = `https://api.notion.com/v1/pages/${pageId}`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Notion-Version": apiVersion,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch Notion page ${pageId}: ${response.statusText} (${response.status})`);
	}

	return await response.json();
}

/**
 * Fetch content blocks from a Notion page
 */
async function fetchNotionPageContent(
	auth: NotionAuthOptions,
	pageId: string,
	convertToMarkdown: boolean,
): Promise<string> {
	const { apiKey, apiVersion = "2022-06-28" } = auth;
	const blocks: NotionBlock[] = [];
	let startCursor: string | undefined;

	while (true) {
		const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`);
		if (startCursor) {
			url.searchParams.set("start_cursor", startCursor);
		}

		const response = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Notion-Version": apiVersion,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch Notion blocks for page ${pageId}: ${response.statusText}`);
		}

		const data: NotionBlockResponse = await response.json();
		blocks.push(...data.results);

		if (!data.has_more) break;
		startCursor = data.next_cursor;
	}

	if (convertToMarkdown) {
		return convertNotionBlocksToMarkdown(blocks);
	} else {
		return JSON.stringify(blocks, null, 2);
	}
}

/**
 * Fetch child pages recursively
 */
async function fetchChildPages(
	auth: NotionAuthOptions,
	parentPageId: string,
	remainingDepth: number,
	convertToMarkdown: boolean,
): Promise<NotionPage[]> {
	if (remainingDepth <= 0) return [];

	const { apiKey, apiVersion = "2022-06-28" } = auth;
	const pages: NotionPage[] = [];
	let startCursor: string | undefined;

	while (true) {
		const url = new URL(`https://api.notion.com/v1/blocks/${parentPageId}/children`);
		if (startCursor) {
			url.searchParams.set("start_cursor", startCursor);
		}

		const response = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Notion-Version": apiVersion,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch child pages for ${parentPageId}: ${response.statusText}`);
		}

		const data: NotionBlockResponse = await response.json();

		// Filter for child page blocks
		const childPageBlocks = data.results.filter(block => block.type === "child_page");

		for (const block of childPageBlocks) {
			try {
				const page = await fetchNotionPage(auth, block.id, convertToMarkdown);
				pages.push(page);

				const grandchildren = await fetchChildPages(auth, block.id, remainingDepth - 1, convertToMarkdown);
				pages.push(...grandchildren);
			} catch (error) {
				// Continue with other pages if one fails
				console.warn(`Failed to fetch child page ${block.id}:`, error);
			}
		}

		if (!data.has_more) break;
		startCursor = data.next_cursor;
	}

	return pages;
}

/**
 * Fetch all pages from a Notion database
 */
async function fetchPagesFromDatabase(
	auth: NotionAuthOptions,
	databaseId: string,
	filterProperty?: string,
	filterValue?: string,
	convertToMarkdown = true,
): Promise<NotionPage[]> {
	const { apiKey, apiVersion = "2022-06-28" } = auth;
	const pages: NotionPage[] = [];
	let startCursor: string | undefined;

	while (true) {
		const url = new URL(`https://api.notion.com/v1/databases/${databaseId}/query`);
		if (startCursor) {
			url.searchParams.set("start_cursor", startCursor);
		}

		const response = await fetch(url.toString(), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Notion-Version": apiVersion,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to query Notion database ${databaseId}: ${response.statusText}`);
		}

		const data: NotionDatabaseResponse = await response.json();

		for (const pageData of data.results) {
			// Apply property filter if specified
			if (filterProperty && filterValue) {
				const propValue = pageData.properties?.[filterProperty];
				if (!propValue || !JSON.stringify(propValue).toLowerCase().includes(filterValue.toLowerCase())) {
					continue;
				}
			}

			const page = await fetchNotionPage(auth, pageData.id, convertToMarkdown);
			pages.push(page);
		}

		if (!data.has_more) break;
		startCursor = data.next_cursor;
	}

	return pages;
}

/**
 * Extract title from Notion page properties
 */
function extractTitleFromPage(pageData: NotionPageResponse): string {
	// Try to find title in properties
	const properties = pageData.properties || {};

	for (const key of Object.keys(properties)) {
		const prop = properties[key];
		if (prop.type === "title" && prop.title && prop.title.length > 0) {
			return prop.title.map((t: any) => t.plain_text).join("");
		}
	}

	// Fallback to page ID if no title found
	return `Page ${pageData.id.slice(-8)}`;
}

/**
 * Convert Notion blocks to markdown
 *
 * Converts Notion block types to their markdown equivalents.
 * This handles common block types; extend as needed for more specific use cases.
 */
function convertNotionBlocksToMarkdown(blocks: NotionBlock[]): string {
	const markdown: string[] = [];
	let inCodeBlock = false;
	let codeLanguage = "";

	for (const block of blocks) {
		// Extract text content from rich text array
		const extractText = (richText: any[]): string => {
			if (!richText) return "";
			return richText
				.map((text: any) => {
					if (text.type === "text") {
						let content = text.text?.content || "";
						if (text.annotations?.bold) content = `**${content}**`;
						if (text.annotations?.italic) content = `*${content}*`;
						if (text.annotations?.code) content = `\`${content}\``;
						if (text.annotations?.strikethrough) content = `~~${content}~~`;
						if (text.text?.link) content = `[${content}](${text.text.link.url})`;
						return content;
					}
					return "";
				})
				.join("");
		};

		switch (block.type) {
			case "paragraph": {
				if (inCodeBlock) {
					markdown.push("```");
					inCodeBlock = false;
				}
				const paragraphText = extractText(block.paragraph?.rich_text || []);
				if (paragraphText) markdown.push(paragraphText);
				markdown.push("");
				break;
			}

			case "heading_1":
				if (inCodeBlock) {
					markdown.push("```");
					inCodeBlock = false;
				}
				markdown.push(`# ${extractText(block.heading_1?.rich_text || [])}`);
				markdown.push("");
				break;

			case "heading_2":
				if (inCodeBlock) {
					markdown.push("```");
					inCodeBlock = false;
				}
				markdown.push(`## ${extractText(block.heading_2?.rich_text || [])}`);
				markdown.push("");
				break;

			case "heading_3":
				if (inCodeBlock) {
					markdown.push("```");
					inCodeBlock = false;
				}
				markdown.push(`### ${extractText(block.heading_3?.rich_text || [])}`);
				markdown.push("");
				break;

			case "bulleted_list_item":
				if (inCodeBlock) {
					markdown.push("```");
					inCodeBlock = false;
				}
				markdown.push(`- ${extractText(block.bulleted_list_item?.rich_text || [])}`);
				break;

			case "numbered_list_item":
				if (inCodeBlock) {
					markdown.push("```");
					inCodeBlock = false;
				}
				markdown.push(`1. ${extractText(block.numbered_list_item?.rich_text || [])}`);
				break;

			case "quote":
				if (inCodeBlock) {
					markdown.push("```");
					inCodeBlock = false;
				}
				markdown.push(`> ${extractText(block.quote?.rich_text || [])}`);
				markdown.push("");
				break;

			case "code":
				if (!inCodeBlock) {
					codeLanguage = block.code?.language || "";
					markdown.push(`\`\`\`${codeLanguage}`);
					inCodeBlock = true;
				}
				markdown.push(extractText(block.code?.rich_text || []));
				break;

			case "callout": {
				if (inCodeBlock) {
					markdown.push("```");
					inCodeBlock = false;
				}
				const calloutText = extractText(block.callout?.rich_text || []);
				markdown.push(`> 💡 ${calloutText}`);
				markdown.push("");
				break;
			}

			case "divider":
				if (inCodeBlock) {
					markdown.push("```");
					inCodeBlock = false;
				}
				markdown.push("---");
				markdown.push("");
				break;

			case "child_page":
				// Child pages are handled separately
				break;

			default:
				// Handle unknown block types
				break;
		}
	}

	// Close code block if still open
	if (inCodeBlock) {
		markdown.push("```");
	}

	return markdown.join("\n").trim();
}

/**
 * Test connection to Notion API
 *
 * Useful for verifying authentication credentials before attempting import.
 *
 * @param auth - Notion authentication options
 * @returns Promise resolving to true if connection successful, false otherwise
 */
export async function testNotionConnection(auth: NotionAuthOptions): Promise<boolean> {
	try {
		const { apiKey, apiVersion = "2022-06-28" } = auth;
		const url = "https://api.notion.com/v1/users/me";

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Notion-Version": apiVersion,
				Accept: "application/json",
			},
		});

		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Get accessible databases for the authenticated integration
 *
 * Useful for discovering available databases before importing.
 *
 * @param auth - Notion authentication options
 * @returns Promise resolving to array of database objects with id and title
 */
export async function getNotionDatabases(auth: NotionAuthOptions): Promise<Array<{ id: string; title: string }>> {
	const { apiKey, apiVersion = "2022-06-28" } = auth;
	const databases: Array<{ id: string; title: string }> = [];
	let startCursor: string | undefined;

	while (true) {
		const url = new URL("https://api.notion.com/v1/search");
		url.searchParams.set(
			"filter",
			JSON.stringify({
				property: "object",
				value: "database",
			}),
		);
		if (startCursor) {
			url.searchParams.set("start_cursor", startCursor);
		}

		const response = await fetch(url.toString(), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Notion-Version": apiVersion,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch databases: ${response.statusText}`);
		}

		const data: {
			results: Array<{ id: string; title: Array<{ type: string; plain_text: string }> }>;
			has_more: boolean;
			next_cursor?: string;
		} = await response.json();

		for (const db of data.results) {
			const title = db.title?.map((t: any) => t.plain_text).join("") || "Untitled";
			databases.push({ id: db.id, title });
		}

		if (!data.has_more) break;
		startCursor = data.next_cursor;
	}

	return databases;
}
