import { describe, expect, it } from "bun:test";
import { Settings } from "../config/settings";
import { parseAgentFields } from "../discovery/helpers";
import { parseFrontmatter } from "../utils/frontmatter";
import { loadBundledAgents } from "./agents";
import { resolveSubagentLaunchOverrides } from "./launch-overrides";

function loadPlanVerifierAgent() {
	const source = Bun.file("/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/agents/plan-verifier.md");
	return source.text().then(text => {
		const parsed = parseAgentFields(parseFrontmatter(text).frontmatter);
		if (!parsed) throw new Error("Expected plan-verifier agent to parse");
		return parsed;
	});
}

describe("resolveSubagentLaunchOverrides", () => {
	it("lets configured default thinking flow through when implement role omits a thinking suffix", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "high" });
		settings.setModelRole("default", "openai-codex/gpt-5.4");
		settings.setModelRole("implement", "openai-codex/gpt-5.3-codex");
		const implement = loadBundledAgents().find(agent => agent.name === "implement");
		if (!implement) throw new Error("Expected implement agent");

		const result = resolveSubagentLaunchOverrides({
			session: { settings },
			agentName: implement.name,
			agentModel: implement.model,
			agentThinkingLevel: implement.thinkingLevel,
			settingsModelOverride: undefined,
		});

		expect(result.modelOverride).toBe("openai-codex/gpt-5.3-codex");
		expect(result.thinkingLevelOverride).toBeUndefined();
	});

	it("preserves explicit configured thinking for implement role", () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "low" });
		settings.setModelRole("default", "openai-codex/gpt-5.4:low");
		settings.setModelRole("implement", "openai-codex/gpt-5.3-codex:high");
		const implement = loadBundledAgents().find(agent => agent.name === "implement");
		if (!implement) throw new Error("Expected implement agent");

		const result = resolveSubagentLaunchOverrides({
			session: { settings },
			agentName: implement.name,
			agentModel: implement.model,
			agentThinkingLevel: implement.thinkingLevel,
			settingsModelOverride: undefined,
		});

		expect(result.modelOverride).toBe("openai-codex/gpt-5.3-codex:high");
		expect(result.thinkingLevelOverride).toBe("high");
	});

	it("lets configured default thinking flow through for plan-verifier when role omits a thinking suffix", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "high" });
		settings.setModelRole("default", "openai-codex/gpt-5.4");
		settings.setModelRole("plan-verifier", "openai-codex/gpt-5.4");
		const planVerifier = await loadPlanVerifierAgent();

		const result = resolveSubagentLaunchOverrides({
			session: { settings },
			agentName: planVerifier.name,
			agentModel: planVerifier.model,
			agentThinkingLevel: planVerifier.thinkingLevel,
			settingsModelOverride: undefined,
		});

		expect(result.modelOverride).toBe("openai-codex/gpt-5.4");
		expect(result.thinkingLevelOverride).toBeUndefined();
	});
});
