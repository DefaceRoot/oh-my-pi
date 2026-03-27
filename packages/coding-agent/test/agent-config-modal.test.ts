import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RolesConfig } from "../src/config/roles-config";
import { AgentConfigModal } from "../src/modes/components/agent-config";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

function renderText(modal: AgentConfigModal, width = 140): string {
	return Bun.stripANSI(modal.render(width).join("\n"));
}

function createModal(
	rolesConfig: RolesConfig,
	subagentDefaultTools: Partial<Record<string, string[]>> = {},
): AgentConfigModal {
	const knownTools = [...new Set(["ast_grep", "read", "write", ...Object.values(subagentDefaultTools).flat()])].filter(
		(tool): tool is string => tool !== undefined,
	);
	return new AgentConfigModal({
		settings: {
			getModelRole: () => undefined,
		} as never,
		rolesConfig,
		knownTools,
		subagentDefaultTools,
		knownMcpServers: [],
		discoveredSkills: [],
		onDismiss: () => {},
		onRequestRender: () => {},
	});
}

function openToolsTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
	for (let i = 0; i < 5; i++) {
		if (renderText(modal).includes("Tools:")) {
			return;
		}
		modal.handleInput("\x1b[C");
	}
	throw new Error(`Tools tab not found in modal:\n${renderText(modal)}`);
}

describe("AgentConfigModal tools integration", () => {
	test("persists role tool toggles through the tools tab", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-role-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig);

			openToolsTab(modal);
			expect(renderText(modal)).toContain("Tools: 1 effective");

			modal.handleInput(" ");

			expect(rolesConfig.getToolsForRole("default")).toEqual([]);
			expect(renderText(modal)).toContain("Tools: 0 effective");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("clears subagent tool overrides back to no config", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-subagent-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
  implement:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  implement:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, { implement: ["ast_grep"] });

			for (let i = 0; i < 4; i++) {
				modal.handleInput("j");
			}
			openToolsTab(modal);
			expect(renderText(modal)).toContain("inherit: implement");

			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.implement?.tools).toEqual({
				inherit: "implement",
				remove: ["ast_grep"],
			});
			expect(renderText(modal)).toContain("Tools: 0 effective");

			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.implement?.tools).toBeUndefined();
			expect(rolesConfig.getToolsForSubagent("implement")).toBeNull();
			expect(renderText(modal)).toContain("Tools: 1 effective (inherit: implement)");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("preserves direct subagent tool arrays when edited", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-direct-subagent-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
  implement:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  implement:
    mcp:
      - augment
    tools:
      - read
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, { implement: ["read"] });

			for (let i = 0; i < 4; i++) {
				modal.handleInput("j");
			}
			openToolsTab(modal);
			expect(renderText(modal)).toContain("space:toggle");
			expect(renderText(modal)).not.toContain("inherit:");

			modal.handleInput("j");
			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.implement?.tools).toEqual([]);
			expect(rolesConfig.getToolsForRole("implement")).toEqual(["ast_grep"]);

			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.implement?.tools).toEqual(["read"]);
			expect(rolesConfig.getToolsForRole("implement")).toEqual(["ast_grep"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("uses runtime subagent defaults when no tools config exists", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-runtime-defaults-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
      - write
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  explore:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, { explore: ["read", "grep"] });

			for (let i = 0; i < 8; i++) {
				modal.handleInput("j");
			}
			openToolsTab(modal);
			expect(renderText(modal)).toContain("space:toggle");
			expect(renderText(modal)).not.toContain("inherit:");
			expect(renderText(modal)).toContain("Tools: 2 effective");

			modal.handleInput("j");
			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.explore?.tools).toEqual(["grep"]);

			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.explore?.tools).toBeUndefined();
			expect(rolesConfig.getToolsForSubagent("explore")).toBeNull();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
