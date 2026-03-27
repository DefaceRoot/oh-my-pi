/**
 * Cursor position marker emitted by focused components.
 *
 * Terminals ignore the APC sequence itself, but layout helpers must also treat
 * it as zero-width so wrapped renderers do not mis-measure focused input lines.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x1b\\";

export function hasCursorMarker(text: string): boolean {
	return text.includes(CURSOR_MARKER);
}

export function stripCursorMarker(text: string): string {
	return hasCursorMarker(text) ? text.replaceAll(CURSOR_MARKER, "") : text;
}
