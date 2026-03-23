import type { ModelRole } from "../config/model-registry";

const SUBAGENT_MODEL_ROLES = new Set<ModelRole>([
	"commit",
	"implement",
	"explore",
	"lint",
	"merge",
	"curator",
	"research",
	"verifier",
	"designer",
	"debug",
	"grafana",
	"worktree-setup",
	"code-reviewer",
	"plan-verifier",
	"coderabbit",
]);

const SUBAGENT_MODEL_ROLE_ALIASES: Readonly<Record<string, ModelRole>> = {
	reviewer: "code-reviewer",
};

export function resolveSubagentRole(agentName: string): ModelRole {
	const aliasRole = SUBAGENT_MODEL_ROLE_ALIASES[agentName];
	if (aliasRole) return aliasRole;
	return SUBAGENT_MODEL_ROLES.has(agentName as ModelRole) ? (agentName as ModelRole) : "implement";
}
