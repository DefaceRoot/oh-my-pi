import type { SubagentOutcome } from "../../task/subagent-outcome";

export type SubagentStatus = "running" | "completed" | "failed" | "pending" | "cancelled" | "user_stopped";

export interface SubagentViewRef {
	id: string;
	sessionPath?: string;
	outputPath?: string;
	agent?: string;
	description?: string;
	provider?: string;
	model?: string;
	tokens?: number;
	contextPreview?: string;
	rootId?: string;
	parentId?: string;
	depth?: number;
	lastUpdatedMs?: number;
	lastSeenOrder?: number;
	status?: SubagentStatus;
	thinkingLevel?: string;
	tokenCapacity?: number;
	startedAt?: number;
	elapsedMs?: number;
	sessionId?: string;
	parentAgentName?: string;
	assignmentPreview?: string;
	abortReason?: string;
	toolNames?: string[];
	mcpServers?: string[];
	mcpAllowlist?: string[];
	outcome?: SubagentOutcome;
}

export interface SubagentViewGroup {
	rootId: string;
	refs: SubagentViewRef[];
	lastUpdatedMs: number;
}

export interface SubagentNavigatorSelection {
	groupIndex: number;
	nestedIndex: number;
}

export interface SubagentIndexSnapshot {
	version: number;
	updatedAt: number;
	refs: SubagentViewRef[];
	groups: SubagentViewGroup[];
}
