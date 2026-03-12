import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { getAgentDir, getProjectDir, Snowflake, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = getAgentDir();
const originalProjectDir = getProjectDir();
const tempDirs: string[] = [];

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function getAnthropicModelOrThrow(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model anthropic/${id}`);
	return model;
}

async function createSelectorFixture(options?: { agentDir?: string; projectDir?: string }) {
	if (options?.agentDir) {
		setAgentDir(options.agentDir);
	}
	if (options?.projectDir) {
		setProjectDir(options.projectDir);
	}

	const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
	const planModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

	const settings = Settings.isolated({
		modelRoles: {
			default: `${defaultModel.provider}/${defaultModel.id}`,
			plan: `${planModel.provider}/${planModel.id}:high`,
		},
	});

	const modelRegistry = {
		getAll: () => [defaultModel, planModel],
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const onSelect = vi.fn();
	const setModelRoleSpy = vi.spyOn(settings, "setModelRole");

	const selector = new ModelSelectorComponent(
		ui,
		defaultModel,
		settings,
		modelRegistry,
		[
			{ model: defaultModel, thinkingLevel: "off" },
			{ model: planModel, thinkingLevel: "off" },
		],
		onSelect,
		() => {},
	);

	await Bun.sleep(0);
	return { selector, onSelect, setModelRoleSpy };
}

function openMcpMenu(selector: ModelSelectorComponent): void {
	selector.handleInput("\n");
	selector.handleInput("\x1b[B");
	selector.handleInput("\n");
	selector.handleInput("\n");
}

describe("Phase 3 RED: /model MCP step", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(async () => {
		setAgentDir(originalAgentDir);
		setProjectDir(originalProjectDir);
		for (const tempDir of tempDirs.splice(0)) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("requires MCP selection before finalizing role assignment", async () => {
		const { selector, onSelect, setModelRoleSpy } = await createSelectorFixture();

		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(normalizeRenderedText(selector.render(220).join("\n"))).toContain(
			"Thinking for: Default (claude-sonnet-4-6)",
		);

		selector.handleInput("\n");
		const afterThinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));

		expect(afterThinkingRendered).toContain("MCP");
		expect(setModelRoleSpy).not.toHaveBeenCalled();
		expect(onSelect).toHaveBeenCalledTimes(0);
	});

	test("shows newly discovered MCP servers after restart while keeping role selections", async () => {
		const tempRoot = path.join(os.tmpdir(), `pi-model-selector-mcp-red-${Snowflake.next()}`);
		tempDirs.push(tempRoot);
		const agentDir = path.join(tempRoot, "agent");
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(projectDir, { recursive: true });

		const rolesYaml = [
			"roles:",
			"  default:",
			"    tools:",
			"      - read",
			"    mcp:",
			"      - augment",
			"      - chrome-devtools",
			"    skills: all",
			"  ask:",
			"    tools:",
			"      - read",
			"    mcp:",
			"      - augment",
			"    skills: none",
			"subagents:",
			"  _default:",
			"    mcp:",
			"      - augment",
			"  research:",
			"    mcp:",
			"      - augment",
		].join("\n");
		await fs.writeFile(path.join(agentDir, "roles.yml"), rolesYaml, "utf-8");
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify(
				{
					mcpServers: {
						augment: { command: "augment-server" },
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const beforeRestart = await createSelectorFixture({ agentDir, projectDir });
		openMcpMenu(beforeRestart.selector);
		const beforeRestartRendered = normalizeRenderedText(beforeRestart.selector.render(220).join("\n"));
		expect(beforeRestartRendered).toContain("[x] augment");
		expect(beforeRestartRendered).toContain("[x] chrome-devtools");
		expect(beforeRestartRendered).not.toContain("better-context");
		expect(beforeRestartRendered).not.toContain("runtime-only-server");

		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify(
				{
					mcpServers: {
						augment: { command: "augment-server" },
						"runtime-only-server": { command: "runtime-server" },
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const afterRestart = await createSelectorFixture({ agentDir, projectDir });
		openMcpMenu(afterRestart.selector);
		const afterRestartRendered = normalizeRenderedText(afterRestart.selector.render(220).join("\n"));
		expect(afterRestartRendered).toContain("[x] augment");
		expect(afterRestartRendered).toContain("[x] chrome-devtools");
		expect(afterRestartRendered).toContain("runtime-only-server");
	});
});
