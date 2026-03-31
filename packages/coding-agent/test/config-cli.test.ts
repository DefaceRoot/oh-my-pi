import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { runConfigCommand } from "../src/cli/config-cli";
import { _resetSettingsForTest } from "../src/config/settings";

let testAgentDir = "";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(async () => {
	_resetSettingsForTest();
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-cli-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	_resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await fs.rm(testAgentDir, { recursive: true, force: true });
});

describe("config CLI schema coverage", () => {
	it("lists non-UI schema settings in JSON output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "list", flags: { json: true } });

		expect(logSpy).toHaveBeenCalledTimes(1);
		const payload = logSpy.mock.calls[0]?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as Record<string, { type: string; description: string }>;

		expect(parsed.enabledModels).toBeDefined();
		expect(parsed.enabledModels.type).toBe("array");
		expect(parsed.enabledModels.description).toBe("");
	});

	it("gets non-UI schema settings by key", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		expect(logSpy).toHaveBeenCalledTimes(1);
		const payload = logSpy.mock.calls[0]?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as {
			key: string;
			type: string;
			description: string;
		};

		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.description).toBe("");
	});

	it("renders record settings as JSON and with record type in text output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "list", flags: {} });

		const lines = logSpy.mock.calls.map(call => String(call[0] ?? ""));
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const modelRolesLine = plainLines.find(line => line.includes("modelRoles ="));
		expect(modelRolesLine).toBeDefined();
		const plainModelRolesLine = String(modelRolesLine);
		expect(plainModelRolesLine).toContain("modelRoles =");
		expect(plainModelRolesLine).toContain("(record)");
		expect(plainModelRolesLine).toContain("{");
		expect(plainModelRolesLine).toContain("}");
		expect(plainModelRolesLine).not.toContain("[object Object]");
	});

	it("sets and gets record settings as JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const recordValue = '{"default":"claude-opus-4-6"}';

		await runConfigCommand({ action: "set", key: "modelRoles", value: recordValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "modelRoles", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("modelRoles");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ default: "claude-opus-4-6" });
	});

	it("sets and gets array settings as JSON arrays", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const arrayValue = '["claude-opus-4-6","gpt-5.3-codex"]';

		await runConfigCommand({ action: "set", key: "enabledModels", value: arrayValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.value).toEqual(["claude-opus-4-6", "gpt-5.3-codex"]);
	});
});

describe("temperature validation", () => {
	/** Set the default model role via CLI so settings reflect it before temperature set. */
	async function configureModel(modelString: string): Promise<void> {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await runConfigCommand({
				action: "set",
				key: "modelRoles",
				value: JSON.stringify({ default: modelString }),
				flags: { json: true },
			});
		} finally {
			logSpy.mockRestore();
		}
	}

	/**
	 * Attempt to set temperature via CLI.
	 * Returns the captured console.error message on validation failure, or undefined on success.
	 */
	async function trySetTemperature(value: string): Promise<string | undefined> {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		let exited = false;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			exited = true;
			return undefined as never;
		});
		try {
			await runConfigCommand({ action: "set", key: "temperature", value, flags: { json: true } });
			if (exited) {
				const msg = errSpy.mock.calls.map(c => String(c[0])).join(" ");
				return msg;
			}
			return undefined;
		} finally {
			logSpy.mockRestore();
			errSpy.mockRestore();
			exitSpy.mockRestore();
		}
	}

	it("-1 always succeeds regardless of configured model", async () => {
		await configureModel("anthropic/claude-3-5-sonnet-20240620");
		const err = await trySetTemperature("-1");
		expect(err).toBeUndefined();
	});

	it("-1 succeeds even with openai-codex model configured", async () => {
		await configureModel("openai-codex/gpt-5-codex");
		const err = await trySetTemperature("-1");
		expect(err).toBeUndefined();
	});

	it("rejects temperature adjustment when openai-codex model is configured", async () => {
		await configureModel("openai-codex/gpt-5-codex");
		const err = await trySetTemperature("1.0");
		expect(err).toBeDefined();
		expect(err).toContain("does not support temperature adjustment");
	});

	it("rejects values above 1.0 when anthropic model is configured", async () => {
		await configureModel("anthropic/claude-3-5-sonnet-20240620");
		const err = await trySetTemperature("1.5");
		expect(err).toBeDefined();
		expect(err).toContain("out of range");
		expect(err).toContain("anthropic-messages");
	});

	it("accepts values within anthropic range (0–1)", async () => {
		await configureModel("anthropic/claude-3-5-sonnet-20240620");
		const err = await trySetTemperature("0.8");
		expect(err).toBeUndefined();
	});

	it("rejects values above 1.0 when bedrock model is configured (bedrock range is 0–1)", async () => {
		await configureModel("amazon-bedrock/anthropic.claude-3-5-haiku-20241022-v1:0");
		const err = await trySetTemperature("1.5");
		expect(err).toBeDefined();
		expect(err).toContain("out of range");
	});

	it("accepts values within bedrock range (0–1)", async () => {
		await configureModel("amazon-bedrock/anthropic.claude-3-5-haiku-20241022-v1:0");
		const err = await trySetTemperature("0.5");
		expect(err).toBeUndefined();
	});

	it("intersects bounds: rejects >1.0 when both anthropic and openai models are configured", async () => {
		// Set both default and ask roles
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await runConfigCommand({
				action: "set",
				key: "modelRoles",
				value: JSON.stringify({
					default: "anthropic/claude-3-5-sonnet-20240620",
					ask: "openai/gpt-4",
				}),
				flags: { json: true },
			});
		} finally {
			logSpy.mockRestore();
		}
		// 0.8 is within anthropic 0–1, so should succeed
		const ok = await trySetTemperature("0.8");
		expect(ok).toBeUndefined();
		// 1.5 exceeds anthropic 0–1 even though openai allows 0–2
		const err = await trySetTemperature("1.5");
		expect(err).toBeDefined();
		expect(err).toContain("out of range");
	});

	it("partial/custom model ID on multi-API provider is not constrained (no false rejection)", async () => {
		// gitlab-duo supports anthropic-messages AND openai-completions AND openai-responses.
		// A partial string 'gitlab-duo/claude' does not exactly match any bundled model,
		// so neither strategy yields a definitive API — bounds fall back to 0–2.
		await configureModel("gitlab-duo/claude");
		const err = await trySetTemperature("1.5");
		expect(err).toBeUndefined();
	});

	it("no model configured: accepts any numeric value in 0–2 (permissive default)", async () => {
		// No model roles set — falls back to 0–2 bounds
		const err = await trySetTemperature("1.8");
		expect(err).toBeUndefined();
	});
});
