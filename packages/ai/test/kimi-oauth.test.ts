import { afterEach, describe, expect, it, vi } from "bun:test";
import { refreshKimiToken } from "../src/utils/oauth/kimi";

const originalFetch = global.fetch;
const SAFETY_BUFFER_MS = 5 * 60 * 1000;

describe("Kimi OAuth expiry handling", () => {
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("applies the same expiry safety buffer as other OAuth providers", async () => {
		const issuedAt = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(issuedAt);
		global.fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "kimi-access",
					refresh_token: "kimi-refresh-next",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const credentials = await refreshKimiToken("kimi-refresh-prev");

		expect(credentials.access).toBe("kimi-access");
		expect(credentials.refresh).toBe("kimi-refresh-next");
		expect(credentials.expires).toBe(issuedAt + 3600 * 1000 - SAFETY_BUFFER_MS);
	});

	it("reuses the previous refresh token when omitted by Kimi", async () => {
		const issuedAt = 1_700_000_500_000;
		vi.spyOn(Date, "now").mockReturnValue(issuedAt);
		global.fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "kimi-access-next",
					expires_in: 1800,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const credentials = await refreshKimiToken("kimi-refresh-prev");

		expect(credentials.access).toBe("kimi-access-next");
		expect(credentials.refresh).toBe("kimi-refresh-prev");
		expect(credentials.expires).toBe(issuedAt + 1800 * 1000 - SAFETY_BUFFER_MS);
	});
});
