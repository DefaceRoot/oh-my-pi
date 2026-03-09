import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { AgentStorage } from "../../src/session/agent-storage";
import { searchPerplexity } from "../../src/web/search/providers/perplexity";

type CapturedRequest = {
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

function getHeaderCaseInsensitive(headers: RequestInit["headers"], name: string): string | undefined {
	if (!headers) return undefined;

	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}

	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
		return match?.[1];
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) {
			return value as string;
		}
	}

	return undefined;
}

const OAUTH_SSE_RESPONSE =
	'data: {"text":"Fresh answer","sources_list":[{"title":"Example","url":"https://example.com","snippet":"Example snippet"}],"display_model":"pplx-pro","uuid":"req-123","final":true}\n\n';

describe("searchPerplexity OAuth auth", () => {
	const originalFetch = globalThis.fetch;
	let capturedRequest: CapturedRequest | null = null;
	let updateAuthCredential: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		capturedRequest = null;
		updateAuthCredential = vi.fn();
		delete process.env.PERPLEXITY_COOKIES;
		delete process.env.PERPLEXITY_API_KEY;

		vi.spyOn(AgentStorage, "open").mockResolvedValue({
			listAuthCredentials: () => [
				{
					id: 1,
					credential: {
						type: "oauth",
						access: "expired-token",
						refresh: "refresh-token",
						expires: Date.now() - 60_000,
					},
				},
			],
			updateAuthCredential,
		} as unknown as AgentStorage);

		vi.spyOn(ai, "getOAuthApiKey").mockResolvedValue({
			apiKey: "fresh-token",
			newCredentials: {
				access: "fresh-token",
				refresh: "refresh-token",
				expires: Date.now() + 60 * 60 * 1000,
			},
		});

		globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			capturedRequest = {
				headers: init?.headers,
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return new Response(OAUTH_SSE_RESPONSE, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		globalThis.fetch = originalFetch;
		capturedRequest = null;
	});

	it("refreshes expired OAuth credentials from agent storage before searching", async () => {
		const result = await searchPerplexity({ query: "refresh test", num_results: 1 });

		expect(ai.getOAuthApiKey).toHaveBeenCalledWith(
			"perplexity",
			expect.objectContaining({
				perplexity: expect.objectContaining({
					access: "expired-token",
					refresh: "refresh-token",
				}),
			}),
		);
		expect(updateAuthCredential).toHaveBeenCalledWith(
			1,
			expect.objectContaining({
				type: "oauth",
				access: "fresh-token",
				refresh: "refresh-token",
			}),
		);
		expect(getHeaderCaseInsensitive(capturedRequest?.headers, "authorization")).toBe("Bearer fresh-token");
		expect(capturedRequest?.body).toMatchObject({
			query_str: expect.stringContaining("refresh test"),
		});
		expect(result.provider).toBe("perplexity");
		expect(result.sources).toHaveLength(1);
		expect(result.answer).toBe("Fresh answer");
	});
});
