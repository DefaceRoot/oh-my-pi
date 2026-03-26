import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("personality setting prompt integration", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-personality-prompt-"));
	});

	afterEach(() => {
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function renderSessionPrompt(settings: Settings): Promise<string> {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			return session.formatSessionAsText();
		} finally {
			await session.dispose();
		}
	}

	function countOccurrences(text: string, needle: string): number {
		return text.split(needle).length - 1;
	}

	it("uses the plain-English personality by default", async () => {
		const prompt = await renderSessionPrompt(Settings.isolated());

		expect(prompt).toContain("## What was wrong");
		expect(countOccurrences(prompt, "## What was wrong")).toBe(1);
	});

	it("uses the technical personality when configured", async () => {
		const defaultPrompt = await renderSessionPrompt(Settings.isolated());
		const technicalPrompt = await renderSessionPrompt(Settings.isolated({ personality: "technical" }));
		const technicalLine = "- (1) Correctness first, (2) Brevity second, (3) Politeness third.";

		expect(countOccurrences(defaultPrompt, technicalLine)).toBe(1);
		expect(countOccurrences(technicalPrompt, technicalLine)).toBe(2);
		expect(technicalPrompt).not.toContain("## What was wrong");
	});
});
