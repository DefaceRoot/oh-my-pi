// Canonical agent IDs (the target state)
export const CANONICAL_AGENT_IDS = [
	"implement", // was: task
	"explore",
	"lint",
	"verifier",
	"designer",
	"research",
	"quick_task",
	"worktree-setup",
	"merge",
	"curator",
	"reviewer",
	"plan",
] as const;

export type CanonicalAgentId = (typeof CANONICAL_AGENT_IDS)[number];

// Historical alias map: old name -> canonical name
export const AGENT_ALIASES: Record<string, CanonicalAgentId> = {
	task: "implement", // the key rename
};

// Canonical model roles
export const CANONICAL_MODEL_ROLES = [
	"default",
	"orchestrator",
	"plan",
	"implement", // replaces subagent going forward
	"temporary",
	"smol",
	"slow",
] as const;

export type CanonicalModelRole = (typeof CANONICAL_MODEL_ROLES)[number];

export const MODEL_ROLE_ALIASES: Record<string, CanonicalModelRole> = {
	subagent: "implement", // no history of this; forward-looking
};

// Normalize any agent name (historical or canonical) to its canonical form.
export function normalizeAgentId(name: string): CanonicalAgentId | string {
	return AGENT_ALIASES[name] ?? name;
}

// Normalize any model role to canonical form.
export function normalizeModelRole(role: string): CanonicalModelRole | string {
	return MODEL_ROLE_ALIASES[role] ?? role;
}
