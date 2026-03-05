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

export interface SidebarSubagent {
	id: string;
	agentName: string;
	status: "running" | "completed" | "failed";
	description?: string;
}

export interface SidebarModel {
	tokens?: SidebarTokenSection;
	mcpServers?: SidebarMcpServer[];
	lspServers?: SidebarLspServer[];
	todos?: SidebarTodoItem[];
	subagents?: SidebarSubagent[];
	width: number;
}
