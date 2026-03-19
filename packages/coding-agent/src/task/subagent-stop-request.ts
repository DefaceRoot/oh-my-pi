export interface TaskSubagentStopRequest {
	id?: string;
	sessionId?: string;
	sessionPath?: string;
	reason: string;
	respond?: (handled: boolean) => void;
}
