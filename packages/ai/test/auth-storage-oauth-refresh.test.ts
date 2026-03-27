import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage } from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";

const TEST_CUSTOM_PROVIDER_ID = "auth-storage-test-provider";
const TEST_CUSTOM_PROVIDER_SOURCE = "auth-storage-oauth-refresh-test";


function findSessionIdForIndex(targetIndex: number, total: number): string {
	for (let i = 0; i < 2000; i += 1) {
		const candidate = `session-${targetIndex}-${i}`;
		if (Bun.hash.xxHash32(candidate) % total === targetIndex) {
			return candidate;
		}
	}
	throw new Error(`Unable to find session id for credential index ${targetIndex}`);
}

async function waitForRefreshStart(getCallCount: () => number): Promise<void> {
	for (let i = 0; i < 20 && getCallCount() === 0; i += 1) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	expect(getCallCount()).toBe(1);
}

describe("AuthStorage OAuth refresh coordination", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-oauth-refresh-"));
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		oauthUtils.unregisterOAuthProviders(TEST_CUSTOM_PROVIDER_SOURCE);
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("reuses one refresh result across concurrent callers instead of disabling the credential", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);

		let releaseFirstRefresh: (() => void) | undefined;
		const firstRefreshGate = new Promise<void>(resolve => {
			releaseFirstRefresh = resolve;
		});
		let refreshCalls = 0;

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			refreshCalls += 1;
			if (credential.refresh !== "refresh-old") {
				return {
					access: "access-new",
					refresh: "refresh-new",
					expires: Date.now() + 60 * 60 * 1000,
				};
			}
			if (refreshCalls === 1) {
				await firstRefreshGate;
				return {
					access: "access-new",
					refresh: "refresh-new",
					expires: Date.now() + 60 * 60 * 1000,
				};
			}
			throw new Error("invalid_grant");
		});

		const first = authStorage.getApiKey("anthropic", "session-a");
		await waitForRefreshStart(() => refreshCalls);

		const second = authStorage.getApiKey("anthropic", "session-b");
		releaseFirstRefresh?.();

		const [firstKey, secondKey] = await Promise.all([first, second]);
		expect(firstKey).toBe("access-new");
		expect(secondKey).toBe("access-new");
		expect(refreshCalls).toBe(1);

		const storedCredentials = store.listAuthCredentials("anthropic");
		expect(storedCredentials).toHaveLength(1);
		const credential = storedCredentials[0]?.credential;
		expect(credential?.type).toBe("oauth");
		if (credential?.type !== "oauth") throw new Error("expected oauth credential");
		expect(credential.refresh).toBe("refresh-new");
		expect(credential.access).toBe("access-new");
	});

	it("preserves refreshed row metadata when refresh payload omits optional fields", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);

		let releaseRefresh: (() => void) | undefined;
		const refreshGate = new Promise<void>(resolve => {
			releaseRefresh = resolve;
		});
		let refreshCalls = 0;

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			refreshCalls += 1;
			expect(credential.refresh).toBe("refresh-old");
			await refreshGate;
			return {
				access: "access-new",
				refresh: "refresh-new",
				expires: Date.now() + 60 * 60 * 1000,
			};
		});

		const apiKeyPromise = authStorage.getApiKey("anthropic", "session-stale");
		await waitForRefreshStart(() => refreshCalls);

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: Date.now() - 30_000,
				accountId: "acct-123",
				email: "dev@example.com",
				projectId: "proj-456",
				enterpriseUrl: "https://enterprise.example",
			},
		]);

		releaseRefresh?.();
		const apiKey = await apiKeyPromise;
		expect(apiKey).toBe("access-new");

		const storedCredentials = store.listAuthCredentials("anthropic");
		expect(storedCredentials).toHaveLength(1);
		const credential = storedCredentials[0]?.credential;
		expect(credential?.type).toBe("oauth");
		if (credential?.type !== "oauth") throw new Error("expected oauth credential");
		expect(credential.refresh).toBe("refresh-new");
		expect(credential.access).toBe("access-new");
		expect(credential.accountId).toBe("acct-123");
		expect(credential.email).toBe("dev@example.com");
		expect(credential.projectId).toBe("proj-456");
		expect(credential.enterpriseUrl).toBe("https://enterprise.example");
	});


	it("uses latest stored metadata for usage fetch after refresh", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		let capturedCredential: {
			accessToken?: string;
			refreshToken?: string;
			accountId?: string;
			email?: string;
			projectId?: string;
			enterpriseUrl?: string;
		} | undefined;
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => {
				if (provider !== "anthropic") return undefined;
				return {
					id: "anthropic",
					supports: () => true,
					fetchUsage: async params => {
						capturedCredential = params.credential;
						return { provider: "anthropic", fetchedAt: Date.now(), limits: [] };
					},
				};
			},
		});

		await authStorage.set("anthropic", [
			{ type: "oauth", access: "access-old", refresh: "refresh-old", expires: Date.now() - 60_000 },
		]);

		let releaseRefresh: (() => void) | undefined;
		const refreshGate = new Promise<void>(resolve => {
			releaseRefresh = resolve;
		});
		let refreshCalls = 0;

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			refreshCalls += 1;
			expect(credential.refresh).toBe("refresh-old");
			await refreshGate;
			return {
				access: "access-new",
				refresh: "refresh-new",
				expires: Date.now() + 60 * 60 * 1000,
			};
		});

		const reportsPromise = authStorage.fetchUsageReports();
		await waitForRefreshStart(() => refreshCalls);

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "access-old",
				refresh: "refresh-old",
				expires: Date.now() - 30_000,
				accountId: "acct-usage",
				email: "usage@example.com",
				projectId: "proj-usage",
				enterpriseUrl: "https://usage.example",
			},
		]);

		releaseRefresh?.();
		const reports = await reportsPromise;
		expect(reports).toHaveLength(1);
		expect(refreshCalls).toBe(1);
		expect(capturedCredential).toBeDefined();
		expect(capturedCredential?.accessToken).toBe("access-new");
		expect(capturedCredential?.refreshToken).toBe("refresh-new");
		expect(capturedCredential?.accountId).toBe("acct-usage");
		expect(capturedCredential?.email).toBe("usage@example.com");
		expect(capturedCredential?.projectId).toBe("proj-usage");
		expect(capturedCredential?.enterpriseUrl).toBe("https://usage.example");
	});


	it("keeps custom-provider refreshes on the same row after a concurrent reorder", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		let releaseFirstRefresh: (() => void) | undefined;
		const firstRefreshGate = new Promise<void>(resolve => {
			releaseFirstRefresh = resolve;
		});
		let refreshCalls = 0;

		oauthUtils.registerOAuthProvider({
			id: TEST_CUSTOM_PROVIDER_ID,
			name: "Auth storage test provider",
			sourceId: TEST_CUSTOM_PROVIDER_SOURCE,
			login: async () => {
				throw new Error("not used in test");
			},
			refreshToken: async credentials => {
				if (credentials.refresh !== "refresh-second-old") {
					throw new Error(`unexpected refresh token: ${credentials.refresh}`);
				}
				refreshCalls += 1;
				if (refreshCalls === 1) {
					await firstRefreshGate;
					return {
						access: "access-second-new",
						refresh: "refresh-second-new",
						expires: Date.now() + 60 * 60 * 1000,
					};
				}
				throw new Error("invalid_grant");
			},
			getApiKey: credentials => credentials.access,
		});

		await authStorage.set(TEST_CUSTOM_PROVIDER_ID, [
			{ type: "oauth", access: "access-first", refresh: "refresh-first", expires: Date.now() + 60 * 60 * 1000 },
			{ type: "oauth", access: "access-second-old", refresh: "refresh-second-old", expires: Date.now() + 5 * 60 * 1000 },
		]);

		const secondCredentialSession = findSessionIdForIndex(1, 2);
		expect(await authStorage.getApiKey(TEST_CUSTOM_PROVIDER_ID, secondCredentialSession)).toBe("access-second-old");

		store.replaceAuthCredentialsForProvider(TEST_CUSTOM_PROVIDER_ID, [
			{ type: "oauth", access: "access-first", refresh: "refresh-first", expires: Date.now() + 60 * 60 * 1000 },
			{ type: "oauth", access: "access-second-old", refresh: "refresh-second-old", expires: Date.now() - 60_000 },
		]);
		await authStorage.reload();

		const apiKeyPromise = authStorage.getApiKey(TEST_CUSTOM_PROVIDER_ID, secondCredentialSession);
		await waitForRefreshStart(() => refreshCalls);

		await authStorage.set(TEST_CUSTOM_PROVIDER_ID, [
			{ type: "oauth", access: "access-second-old", refresh: "refresh-second-old", expires: Date.now() - 30_000 },
			{ type: "oauth", access: "access-first", refresh: "refresh-first", expires: Date.now() + 60 * 60 * 1000 },
		]);

		releaseFirstRefresh?.();

		const apiKey = await apiKeyPromise;
		expect(apiKey).toBe("access-second-new");
		expect(refreshCalls).toBe(1);

		const storedCredentials = store.listAuthCredentials(TEST_CUSTOM_PROVIDER_ID);
		expect(storedCredentials).toHaveLength(2);
		const firstCredential = storedCredentials[0]?.credential;
		const secondCredential = storedCredentials[1]?.credential;
		expect(firstCredential?.type).toBe("oauth");
		expect(secondCredential?.type).toBe("oauth");
		if (firstCredential?.type !== "oauth" || secondCredential?.type !== "oauth") {
			throw new Error("expected oauth credentials");
		}
		expect(firstCredential.access).toBe("access-second-new");
		expect(firstCredential.refresh).toBe("refresh-second-new");
		expect(secondCredential.access).toBe("access-first");
		expect(secondCredential.refresh).toBe("refresh-first");
		expect(await authStorage.getApiKey(TEST_CUSTOM_PROVIDER_ID, secondCredentialSession)).toBe("access-second-new");
	});


	it("keeps refreshed credentials on the same row after a concurrent reorder", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", access: "access-first", refresh: "refresh-first", expires: Date.now() + 60 * 60 * 1000 },
			{ type: "oauth", access: "access-second-old", refresh: "refresh-second-old", expires: Date.now() + 5 * 60 * 1000 },
		]);

		const secondCredentialSession = findSessionIdForIndex(1, 2);
		expect(await authStorage.getApiKey("anthropic", secondCredentialSession)).toBe("access-second-old");

		store.replaceAuthCredentialsForProvider("anthropic", [
			{ type: "oauth", access: "access-first", refresh: "refresh-first", expires: Date.now() + 60 * 60 * 1000 },
			{ type: "oauth", access: "access-second-old", refresh: "refresh-second-old", expires: Date.now() - 60_000 },
		]);
		await authStorage.reload();

		let releaseFirstRefresh: (() => void) | undefined;
		const firstRefreshGate = new Promise<void>(resolve => {
			releaseFirstRefresh = resolve;
		});
		let refreshCalls = 0;

		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			if (credential.refresh !== "refresh-second-old") {
				throw new Error(`unexpected refresh token: ${credential.refresh}`);
			}
			refreshCalls += 1;
			if (refreshCalls === 1) {
				await firstRefreshGate;
				return {
					access: "access-second-new",
					refresh: "refresh-second-new",
					expires: Date.now() + 60 * 60 * 1000,
				};
			}
			throw new Error("invalid_grant");
		});

		const apiKeyPromise = authStorage.getApiKey("anthropic", secondCredentialSession);
		await waitForRefreshStart(() => refreshCalls);

		await authStorage.set("anthropic", [
			{ type: "oauth", access: "access-second-old", refresh: "refresh-second-old", expires: Date.now() - 30_000 },
			{ type: "oauth", access: "access-first", refresh: "refresh-first", expires: Date.now() + 60 * 60 * 1000 },
		]);

		releaseFirstRefresh?.();

		const apiKey = await apiKeyPromise;
		expect(apiKey).toBe("access-second-new");
		expect(refreshCalls).toBe(1);

		const storedCredentials = store.listAuthCredentials("anthropic");
		expect(storedCredentials).toHaveLength(2);
		const firstCredential = storedCredentials[0]?.credential;
		const secondCredential = storedCredentials[1]?.credential;
		expect(firstCredential?.type).toBe("oauth");
		expect(secondCredential?.type).toBe("oauth");
		if (firstCredential?.type !== "oauth" || secondCredential?.type !== "oauth") {
			throw new Error("expected oauth credentials");
		}
		expect(firstCredential.access).toBe("access-second-new");
		expect(firstCredential.refresh).toBe("refresh-second-new");
		expect(secondCredential.access).toBe("access-first");
		expect(secondCredential.refresh).toBe("refresh-first");
	});
});
