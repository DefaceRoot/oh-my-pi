export interface SubagentResumeRequest {
	id?: string;
	sessionId?: string;
	sessionPath?: string;
	/** Optional message to send as the continuation prompt. Falls back to a default continue message if omitted. */
	continueMessage?: string;
	respond?: (handled: boolean) => void;
}
