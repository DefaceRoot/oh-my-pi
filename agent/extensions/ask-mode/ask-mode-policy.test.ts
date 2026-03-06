import { describe, expect, it } from "bun:test";
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

    it("allows submit_result tool", () => {
      expectAllowed(askResearchContext(), "submit_result");
    });
  });
});
