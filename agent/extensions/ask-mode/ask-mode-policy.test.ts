import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { YAML } from "bun";
import { RolesConfig } from "@oh-my-pi/pi-coding-agent/config/roles-config";
import { _testExports } from "./index.ts";

type PolicyContext = ReturnType<(typeof _testExports)["isAskContext"]>;

const parentAskContext = (): PolicyContext =>
  _testExports.isAskContext({
    role: "ask",
    agent: "default",
  });

const askExploreContext = (): PolicyContext =>
  _testExports.isAskContext({
    role: "default",
    agent: "ask-explore",
  });

const askResearchContext = (): PolicyContext =>
  _testExports.isAskContext({
    role: "default",
    agent: "ask-research",
  });

const decisionFor = (context: PolicyContext, toolName: string, input?: Record<string, unknown>) =>
  _testExports.shouldBlockTool(
    {
      toolName,
      input,
    },
    context,
  );

const expectBlocked = (context: PolicyContext, toolName: string, input?: Record<string, unknown>) => {
  const decision = decisionFor(context, toolName, input);
  expect(decision?.block).toBe(true);
};

const expectAllowed = (context: PolicyContext, toolName: string, input?: Record<string, unknown>) => {
  const decision = decisionFor(context, toolName, input);
  expect(decision).toBeUndefined();
};


type RolesFileShape = {
  roles?: Record<string, { tools?: unknown }>;
};

const repoRolesPath = path.resolve(import.meta.dir, "..", "..", "roles.yml");

async function readAskToolsFromRepoRoles(): Promise<string[]> {
  const parsed = YAML.parse(await Bun.file(repoRolesPath).text()) as RolesFileShape;
  const tools = parsed.roles?.ask?.tools;
  if (!Array.isArray(tools) || tools.some(tool => typeof tool !== "string")) {
    throw new Error("Expected roles.yml to define roles.ask.tools as a string array");
  }
  return tools;
}

const readSubagentMcpFromRepoRoles = (agentName: string): string[] => {
  const rolesConfig = new RolesConfig(repoRolesPath);
  return rolesConfig.getMcpForSubagent(agentName);
};
describe("ask-mode policy", () => {
  describe("parent ask role", () => {
    it("blocks edit tool", () => {
      expectBlocked(parentAskContext(), "edit");
    });

    it("blocks write tool", () => {
      expectBlocked(parentAskContext(), "write");
    });

    it("blocks notebook tool", () => {
      expectBlocked(parentAskContext(), "notebook");
    });

    it("blocks todo_write tool", () => {
      expectBlocked(parentAskContext(), "todo_write");
    });

    it("blocks ssh tool", () => {
      expectBlocked(parentAskContext(), "ssh");
    });

    it("blocks bash tool", () => {
      expectBlocked(parentAskContext(), "bash");
    });

    it("allows read tool", () => {
      expectAllowed(parentAskContext(), "read");
    });

    it("allows grep tool", () => {
      expectAllowed(parentAskContext(), "grep");
    });

    it("allows find tool", () => {
      expectAllowed(parentAskContext(), "find");
    });

    it("allows fetch tool", () => {
      expectAllowed(parentAskContext(), "fetch");
    });

    it("allows web_search tool", () => {
      expectAllowed(parentAskContext(), "web_search");
    });

    it("allows submit_result tool", () => {
      expectAllowed(parentAskContext(), "submit_result");
    });

    it("blocks lsp rename action", () => {
      expectBlocked(parentAskContext(), "lsp", {
        action: "rename",
      });
    });

    it("blocks lsp code_actions with apply=true", () => {
      expectBlocked(parentAskContext(), "lsp", {
        action: "code_actions",
        apply: true,
      });
    });

    it("allows lsp hover action", () => {
      expectAllowed(parentAskContext(), "lsp", {
        action: "hover",
      });
    });

    it("allows lsp definition action", () => {
      expectAllowed(parentAskContext(), "lsp", {
        action: "definition",
      });
    });

    it("allows lsp references action", () => {
      expectAllowed(parentAskContext(), "lsp", {
        action: "references",
      });
    });

    it("allows task for ask-explore target", () => {
      expectAllowed(parentAskContext(), "task", {
        agent: "ask-explore",
      });
    });

    it("allows task for ask-research target", () => {
      expectAllowed(parentAskContext(), "task", {
        agent: "ask-research",
      });
    });

    it("blocks task for implement target", () => {
      expectBlocked(parentAskContext(), "task", {
        agent: "implement",
      });
    });

    it("blocks task for explore target", () => {
      expectBlocked(parentAskContext(), "task", {
        agent: "explore",
      });
    });

    it("blocks task for lint target", () => {
      expectBlocked(parentAskContext(), "task", {
        agent: "lint",
      });
    });

    it("keeps persisted ask tools aligned with enforced parent ask policy", async () => {
      const configuredTools = await readAskToolsFromRepoRoles();
      for (const tool of configuredTools) {
        expect(decisionFor(parentAskContext(), tool)).toBeUndefined();
      }
    });
  });

  describe("ask-explore subagent", () => {
    it("blocks edit tool", () => {
      expectBlocked(askExploreContext(), "edit");
    });

    it("allows read tool", () => {
      expectAllowed(askExploreContext(), "read");
    });

    it("allows grep tool", () => {
      expectAllowed(askExploreContext(), "grep");
    });

    it("blocks task tool entirely", () => {
      expectBlocked(askExploreContext(), "task", {
        agent: "ask-research",
      });
    });

    it("keeps ask-explore MCP allocation aligned with ask-mode split policy", () => {
      const configuredMcpServers = readSubagentMcpFromRepoRoles("ask-explore");
      const askExploreAllowsAugment =
        decisionFor(askExploreContext(), "mcp_augment_codebase_retrieval") === undefined;
      expect(configuredMcpServers.includes("augment")).toBe(askExploreAllowsAugment);
    });

    it("allows submit_result tool", () => {
      expectAllowed(askExploreContext(), "submit_result");
    });
  });

  describe("ask-research subagent", () => {
    it("allows fetch tool", () => {
      expectAllowed(askResearchContext(), "fetch");
    });

    it("allows web_search tool", () => {
      expectAllowed(askResearchContext(), "web_search");
    });

    it("blocks task tool entirely", () => {
      expectBlocked(askResearchContext(), "task", {
        agent: "ask-explore",
      });
    });

    it("keeps ask-research MCP allocation aligned with ask-mode split policy", () => {
      const configuredMcpServers = readSubagentMcpFromRepoRoles("ask-research");
      const askResearchAllowsAugment =
        decisionFor(askResearchContext(), "mcp_augment_codebase_retrieval") === undefined;
      expect(configuredMcpServers.includes("augment")).toBe(askResearchAllowsAugment);
    });

    it("allows submit_result tool", () => {
      expectAllowed(askResearchContext(), "submit_result");
    });
  });
});
