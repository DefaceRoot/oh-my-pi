import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(implementationEnginePath).text();

describe("subagent thinking guard", () => {
	test("before_agent_start marks headless sessions as subagent turns", async () => {
		const content = await readExtensionSource();

		expect(content).toMatch(/if \(!ctx\.hasUI\)/);
		expect(content).toMatch(/activeAgentIsParentTurn\s*=\s*false/);
		expect(content).toMatch(/activeParentRuntimeRole\s*=\s*"default"/);
	});

	test("before_agent_start skips runtime default sync for delegated subagents", async () => {
		const content = await readExtensionSource();

		expect(content).toMatch(/isNestedTaskSession/);
		expect(content).toMatch(/isSubagentTurn\(event\.systemPrompt, promptText\)/);
		expect(content).toMatch(/skipping parent runtime default sync for subagent turn/);
	});

	test("legacy startup thinking sync helper is removed", async () => {
		const content = await readExtensionSource();

		expect(content).not.toMatch(/syncThinkingLevelForCurrentRole/);
	});
});

describe("non-worktree role thinking sync", () => {
	test("before_agent_start else branch applies thinking from model-role-thinking.json", async () => {
		const content = await readExtensionSource();

		// The else branch (non-worktree path) must sync thinking for parent turns
		expect(content).toMatch(/Non-worktree sessions: sync thinking from model-role-thinking\.json for parent turns/);
		// Must use lastModelRole for exact role lookup (plan, merge, etc.)
		expect(content).toMatch(/lastModelRole\s*\?\s*persistedLevels\[lastModelRole\]/);
		// Must fall back to activeParentRuntimeRole bucket (orchestrator or default)
		expect(content).toMatch(/persistedLevels\[activeParentRuntimeRole\]/);
	});

	test("session_start applies thinking from model-role-thinking.json immediately", async () => {
		const content = await readExtensionSource();

		// session_start must sync thinking so status line is correct on OMP startup
		expect(content).toMatch(/synced role thinking level on session start/);
		// Must use getLastModelChangeRole to find the session's active role
		expect(content).toMatch(/getLastModelChangeRole\(ctx\)/);
		// Must resolve via resolveParentRuntimeRole for fallback
		expect(content).toMatch(/resolveParentRuntimeRole\(sessionRole\)/);
	});

	test("session_switch applies thinking from model-role-thinking.json immediately", async () => {
		const content = await readExtensionSource();

		// session_switch must sync thinking so status line is correct on alt+a
		expect(content).toMatch(/synced role thinking level on session switch/);
	});

	test("thinking sync respects exact role keys before falling back to orchestrator/default", async () => {
		const content = await readExtensionSource();

		// The lookup pattern: persistedLevels[exactRole] ?? persistedLevels[bucketRole]
		// This means 'plan: xhigh' in the JSON is respected for plan sessions, not just 'default: high'
		const sessionRoleLookupPattern =
			/sessionRole\s*\?\s*persistedLevels\[sessionRole\].*persistedLevels\[resolveParentRuntimeRole\(sessionRole\)\]/s;
		expect(content).toMatch(sessionRoleLookupPattern);
	});

	test("thinking sync catches missing metadata errors instead of breaking extension commands", async () => {
		const content = await readExtensionSource();

		expect(content).toMatch(/applyThinkingLevelSafely\s*=\s*\(/);
		expect(content).toMatch(/missing thinking metadata/);
	});

	test("thinking sync routes through the guarded helper", async () => {
		const content = await readExtensionSource();
		const directCalls = (content.match(/pi\.setThinkingLevel\(/g) ?? []).length;

		// Only the helper should call pi.setThinkingLevel directly.
		expect(directCalls).toBe(1);
		expect(content).toMatch(/applyThinkingLevelSafely\(/);
	});
});
