export type SubagentStatus = "running" | "completed" | "failed" | "pending" | "cancelled";

export interface SubagentViewRef {
	id: string;
	sessionPath?: string;
	outputPath?: string;
	agent?: string;
	description?: string;
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
