export interface SubagentResumeRequest {
	id?: string;
	sessionId?: string;
	sessionPath?: string;
	continueMessage?: string;
	respond?: (handled: boolean) => void;
}
