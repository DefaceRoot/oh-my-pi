export interface SubagentRuntimeLookup {
	id?: string;
	sessionId?: string;
	sessionPath?: string;
}

export interface RegisteredSubagentRuntime extends SubagentRuntimeLookup {
	id: string;
	stop: (reason: string) => boolean | Promise<boolean>;
}

const runtimesById = new Map<string, RegisteredSubagentRuntime>();
const runtimeIdsBySessionId = new Map<string, string>();
const runtimeIdsBySessionPath = new Map<string, string>();

function resolveRuntimeId(lookup: SubagentRuntimeLookup): string | undefined {
	if (lookup.id && runtimesById.has(lookup.id)) {
		return lookup.id;
	}
	if (lookup.sessionId) {
		const id = runtimeIdsBySessionId.get(lookup.sessionId);
		if (id) return id;
	}
	if (lookup.sessionPath) {
		const id = runtimeIdsBySessionPath.get(lookup.sessionPath);
		if (id) return id;
	}
	return undefined;
}

export function registerSubagentRuntime(runtime: RegisteredSubagentRuntime): void {
	runtimesById.set(runtime.id, runtime);
	if (runtime.sessionId) {
		runtimeIdsBySessionId.set(runtime.sessionId, runtime.id);
	}
	if (runtime.sessionPath) {
		runtimeIdsBySessionPath.set(runtime.sessionPath, runtime.id);
	}
}

export function unregisterSubagentRuntime(id: string): void {
	const existing = runtimesById.get(id);
	if (!existing) return;
	runtimesById.delete(id);
	if (existing.sessionId) {
		runtimeIdsBySessionId.delete(existing.sessionId);
	}
	if (existing.sessionPath) {
		runtimeIdsBySessionPath.delete(existing.sessionPath);
	}
}

export async function stopSubagentRuntime(lookup: SubagentRuntimeLookup, reason: string): Promise<boolean> {
	const runtimeId = resolveRuntimeId(lookup);
	if (!runtimeId) return false;
	const runtime = runtimesById.get(runtimeId);
	if (!runtime) return false;
	return await runtime.stop(reason);
}

export function clearSubagentRuntimeRegistry(): void {
	runtimesById.clear();
	runtimeIdsBySessionId.clear();
	runtimeIdsBySessionPath.clear();
}

