import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession last user images", () => {
	let tempDir: string;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-last-user-images-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSessionForTest() {
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"skills.enabled": false,
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;
		return session;
	}

	function syncMessagesFromSessionManager() {
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
	}

	it("returns only image parts from the most recent user array message", async () => {
		await createSessionForTest();

		const firstImage: ImageContent = { type: "image", data: "Zm9v", mimeType: "image/png" };
		const secondImage: ImageContent = { type: "image", data: "YmFy", mimeType: "image/jpeg" };
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "look" }, firstImage, { type: "text", text: "again" }, secondImage],
			timestamp: Date.now() - 1,
		});
		syncMessagesFromSessionManager();

		expect(session.getLastUserImages()).toEqual([firstImage, secondImage]);
	});

	it("returns undefined when the most recent user message content is string", async () => {
		await createSessionForTest();

		const image: ImageContent = { type: "image", data: "Zm9v", mimeType: "image/png" };
		session.sessionManager.appendMessage({
			role: "user",
			content: [image],
			timestamp: Date.now() - 2,
		});
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ack" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			timestamp: Date.now() - 1,
		});
		session.sessionManager.appendMessage({
			role: "user",
			content: "plain text only",
			timestamp: Date.now(),
		});
		syncMessagesFromSessionManager();

		expect(session.getLastUserImages()).toBeUndefined();
	});
});
