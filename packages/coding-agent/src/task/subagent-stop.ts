export const USER_STOPPED_ABORT_PREFIX = "User stopped:";

export function isUserStoppedAbortReason(reason: string | undefined): boolean {
	if (!reason) return false;
	return reason.trimStart().startsWith(USER_STOPPED_ABORT_PREFIX);
}

export function buildUserStoppedAbortReason(reason: string | undefined): string {
	const trimmed = reason?.trim();
	if (!trimmed) {
		return `${USER_STOPPED_ABORT_PREFIX} no reason provided`;
	}
	return isUserStoppedAbortReason(trimmed) ? trimmed : `${USER_STOPPED_ABORT_PREFIX} ${trimmed}`;
}
