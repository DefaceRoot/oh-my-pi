export type ResumeAgentMode = "default" | "ask" | "orchestrator" | "plan" | "unknown";
export type KnownResumeAgentMode = Exclude<ResumeAgentMode, "unknown">;

export const RESUME_AGENT_MODE_STYLES = {
	default: { label: "Default", color: "success" },
	ask: { label: "Ask", color: "statusLineSubagents" },
	orchestrator: { label: "Orchestrator", color: "warning" },
	plan: { label: "Plan", color: "statusLineContext" },
	unknown: { label: "unknown", color: "dim" },
} as const;

const KNOWN_RESUME_AGENT_MODES = new Set<KnownResumeAgentMode>([
	"default",
	"ask",
	"orchestrator",
	"plan",
]);

export function normalizeResumeAgentMode(role: unknown): KnownResumeAgentMode | undefined {
	if (role == null) return "default";
	if (typeof role !== "string") return undefined;
	const normalized = role.trim().toLowerCase();
	return KNOWN_RESUME_AGENT_MODES.has(normalized as KnownResumeAgentMode)
		? (normalized as KnownResumeAgentMode)
		: undefined;
}

export function extractLastResumeAgentMode(
	lines: Iterable<string>,
): KnownResumeAgentMode | null | undefined {
	const entries = Array.isArray(lines) ? lines : Array.from(lines);
	for (let i = entries.length - 1; i >= 0; i--) {
		const line = entries[i];
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as { type?: unknown; role?: unknown };
			if (entry.type !== "model_change") continue;
			return normalizeResumeAgentMode(entry.role) ?? null;
		} catch {
			continue;
		}
	}
	return undefined;
}

export function detectLegacyResumeAgentMode(allMessagesText: string): ResumeAgentMode {
	if (!allMessagesText) return "unknown";
	if (
		allMessagesText.includes("Orchestrator mode") ||
		allMessagesText.includes("implementation-engine/")
	) {
		return "orchestrator";
	}
	if (
		allMessagesText.includes("Plan mode") ||
		allMessagesText.includes("Plan Mode") ||
		allMessagesText.includes(".omp/sessions/plans/")
	) {
		return "plan";
	}
	if (allMessagesText.includes("Ask mode") || allMessagesText.includes("Ask Mode")) {
		return "ask";
	}
	if (
		allMessagesText.includes("Default Mode") ||
		allMessagesText.includes("Default mode")
	) {
		return "default";
	}
	return "unknown";
}

export function resolveResumeAgentMode(params: {
	knownRole?: KnownResumeAgentMode;
	sessionLines?: Iterable<string> | null;
	allMessagesText?: string | null;
}): ResumeAgentMode {
	if (params.knownRole) return params.knownRole;

	const sessionRole = params.sessionLines
		? extractLastResumeAgentMode(params.sessionLines)
		: undefined;
	if (sessionRole) return sessionRole;
	if (sessionRole === null) return "unknown";

	return detectLegacyResumeAgentMode(params.allMessagesText ?? "");
}
