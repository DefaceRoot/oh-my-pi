export interface SidebarTokenSection {
	contextUsedPercent: number;
	tokensUsed: number;
	tokensTotal: number;
	costUsd?: number;
}

export interface SidebarMcpServer {
	name: string;
	connected: boolean;
}

export interface SidebarLspServer {
	name: string;
	active: boolean;
}

export interface SidebarTodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
}

export type SidebarSubagentStatus = "running" | "completed" | "failed";

interface SidebarSubagentRowBase {
	id: string;
	agentName: string;
	status: SidebarSubagentStatus;
}

export interface SidebarSubagentChildRow extends SidebarSubagentRowBase {
	kind: "child";
}

export interface SidebarSubagentParentRow extends SidebarSubagentRowBase {
	kind: "parent";
	title?: string;
	children?: SidebarSubagentChildRow[];
}

export type SidebarSubagent = SidebarSubagentParentRow;

export interface SidebarModifiedFile {
	path: string;
	status: "M" | "A" | "D" | "R" | "?";
}

export interface SidebarModel {
	tokens?: SidebarTokenSection;
	mcpServers?: SidebarMcpServer[];
	lspServers?: SidebarLspServer[];
	todos?: SidebarTodoItem[];
	subagents?: SidebarSubagent[];
	modifiedFiles?: SidebarModifiedFile[];
	width: number;
	animationFrame?: number;
}
