export interface SubagentResumeRequest {
	id?: string;
	sessionId?: string;
	sessionPath?: string;
	respond?: (handled: boolean) => void;
}
