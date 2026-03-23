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
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
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
	parentSessionId?: string;
	parentAgentName?: string;
	assignmentPreview?: string;
	abortReason?: string;
	toolNames?: string[];
	mcpServers?: string[];
	mcpAllowlist?: string[];
	outcome?: SubagentOutcome;

	/** File edit statistics computed from session transcript */
	filesChanged?: number;
	linesAdded?: number;
	linesDeleted?: number;

	/** Delegation metadata — populated from JSON sidecar when available */
	taskTitle?: string;
	taskId?: string;
	taskIntent?: string;
	planPath?: string;
	branch?: string;
	repoRoot?: string;
	worktreePath?: string;
	delegatorRole?: string;
	delegateRole?: string;
	inputProfile?: string;
	envelopeId?: string;
	parentEnvelopeId?: string;
	retryAttempt?: number;
	qualityWarnings?: string[];
	qualityErrors?: string[];
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
