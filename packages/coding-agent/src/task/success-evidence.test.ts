import { describe, expect, test } from "bun:test";
import codeReviewerAgentText from "../../../../agent/agents/code-reviewer.md" with { type: "text" };
import lintAgentText from "../../../../agent/agents/lint.md" with { type: "text" };
import { parseAgentFields } from "../discovery/helpers";
import { parseFrontmatter } from "../utils/frontmatter";
import { validateSuccessToolRequirements } from "./success-evidence";

describe("parseAgentFields successRequiresTools", () => {
	test("parses success-requires-tools from frontmatter", () => {
		const { frontmatter } = parseFrontmatter(`---
	name: lint
	description: Evidence-enforced lint agent
	success-requires-tools:
	  - bash
---
`);

		const parsed = parseAgentFields(frontmatter);
		expect(parsed?.successRequiresTools).toEqual(["bash"]);
	});

	test("project lint and review agents declare completion evidence requirements", () => {
		const lintAgent = parseAgentFields(parseFrontmatter(lintAgentText).frontmatter);
		const codeReviewerAgent = parseAgentFields(parseFrontmatter(codeReviewerAgentText).frontmatter);

		expect(lintAgent?.successRequiresTools).toEqual(["bash"]);
		expect(codeReviewerAgent?.successRequiresTools).toEqual([
			"read",
			"grep",
			"find",
			"bash",
			"lsp",
			"ast_grep",
		]);
	});
});

describe("validateSuccessToolRequirements", () => {
	test("allows success when agent has no explicit evidence requirement", () => {
		expect(
			validateSuccessToolRequirements(
				{ name: "explore" },
				new Set<string>(),
			),
		).toBeNull();
	});

	test("rejects success when required tools never ran", () => {
		expect(
			validateSuccessToolRequirements(
				{ name: "lint", successRequiresTools: ["bash"] },
				new Set(["submit_result"]),
			),
		).toContain('must run at least one of: bash');
	});

	test("allows success when any required tool ran", () => {
		expect(
			validateSuccessToolRequirements(
				{ name: "code-reviewer", successRequiresTools: ["read", "grep", "bash"] },
				new Set(["read", "submit_result"]),
			),
		).toBeNull();
	});
});
