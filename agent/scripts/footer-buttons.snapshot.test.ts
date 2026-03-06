import { describe, expect, test } from "bun:test";

const LIVE_INTERACTIVE_MODE_PATH =
	"/home/colin/.omp/agent/patches/implement-workflow-clickable-v11.7.2/files/pi-coding-agent/src/modes/interactive-mode.ts";

interface ParsedActionButton {
	label: string;
	command: string;
	statusKey: string;
	normalText: string;
	hoverText: string;
	editorText?: string;
}

const REQUIRED_LABELS = ["Plan Review", "Fix Plan", "Submit PR", "Review", "Fix Issues", "Cleanup", "✕ Worktree"];

const EXPECTED_BUTTON_STYLES: Array<Pick<ParsedActionButton, "label" | "command" | "normalText" | "hoverText">> = [
	{
		label: "Worktree",
		command: "/planned-worktree",
		normalText: "\x1b[30;45m Worktree \x1b[0m",
		hoverText: "\x1b[30;105m Worktree \x1b[0m",
	},
	{
		label: "Git",
		command: "/git-menu",
		normalText: "\x1b[30;42m Git \x1b[0m",
		hoverText: "\x1b[30;102m Git \x1b[0m",
	},
	{
		label: "! Sync",
		command: "/git-menu",
		normalText: "\x1b[30;103m ! Sync \x1b[0m",
		hoverText: "\x1b[30;43m ! Sync \x1b[0m",
	},
	{
		label: "Freeform",
		command: "/freeform-worktree",
		normalText: "\x1b[30;45m Freeform \x1b[0m",
		hoverText: "\x1b[30;105m Freeform \x1b[0m",
	},
	{
		label: "Planned",
		command: "/planned-worktree",
		normalText: "\x1b[30;46m Planned \x1b[0m",
		hoverText: "\x1b[30;106m Planned \x1b[0m",
	},
	{
		label: "Submit PR",
		command: "/submit-pr",
		normalText: "\x1b[30;42m Submit PR \x1b[0m",
		hoverText: "\x1b[30;102m Submit PR \x1b[0m",
	},
	{
		label: "Review",
		command: "/review-complete",
		normalText: "\x1b[30;44m Review \x1b[0m",
		hoverText: "\x1b[30;104m Review \x1b[0m",
	},
	{
		label: "Fix Issues",
		command: "/fix-issues",
		normalText: "\x1b[30;47m Fix Issues \x1b[0m",
		hoverText: "\x1b[30;107m Fix Issues \x1b[0m",
	},
	{
		label: "Update Version",
		command: "/update-version-workflow",
		normalText: "\x1b[30;46m Update Version \x1b[0m",
		hoverText: "\x1b[30;106m Update Version \x1b[0m",
	},
	{
		label: "✕ Worktree",
		command: "/delete-worktree",
		normalText: "\x1b[30;41m ✕ Worktree \x1b[0m",
		hoverText: "\x1b[30;101m ✕ Worktree \x1b[0m",
	},
	{
		label: "Cleanup",
		command: "/cleanup-worktrees",
		normalText: "\x1b[30;43m Cleanup \x1b[0m",
		hoverText: "\x1b[30;103m Cleanup \x1b[0m",
	},
	{
		label: "Plan Review",
		command: "/plan-review",
		normalText: "\x1b[30;42m Plan Review \x1b[0m",
		hoverText: "\x1b[30;102m Plan Review \x1b[0m",
	},
	{
		label: "Fix Plan",
		command: "/fix-plan",
		normalText: "\x1b[30;42m Fix Plan \x1b[0m",
		hoverText: "\x1b[30;102m Fix Plan \x1b[0m",
	},
];

const EXPECTED_PLAN_REVIEW_EDITOR_TEXT =
	"Review this plan for issues/ambiguities, make sure there are no edge cases being missed. Spawn multiple task subagents for each phase to review the phases in the plan. Do not edit the plan, give me an output with all the synthesized data in a beginner friendly, clear and concise list with numbered labelings for each issue identified and why it may be an issue, do not use technical jargain or undefined acronyms, I want each thing explained clearly and concisely, so that I can understand it and give you guideance. Use research agents in parallel for anything that need up-to-date information, to ensure it is accurate as of today. If there are no issues/ambiguities or edge cases identified, that is fine, do not make up things to try to please me, but also do not overlook potential problems from the plan that may be identified during implementation. Utilize your full suite of subagents, prioritize parallel work as this is a READ-ONLY task that is preferred to be quicker, so parallel subagents are required.\n\nPlan File:\n";

const EXPECTED_FIX_PLAN_EDITOR_TEXT =
	"Another agent reviewed this plan and found issues listed below. Read the plan file, then apply each fix directly — do NOT spawn subagents or use isolated mode, just edit the plan file yourself one fix at a time. Do NOT implement the plan or change any other files. Keep changes strictly limited to resolving the identified problems: clarify ambiguous steps, add missing edge cases, tighten verification criteria, and correct factual errors. Do not expand scope or rewrite parts that are not broken. Use research tools if you need up-to-date information to verify a fix.\n\nPlan Review Output:\n";

async function readLiveInteractiveSource(): Promise<string> {
	const file = Bun.file(LIVE_INTERACTIVE_MODE_PATH);
	if (!(await file.exists())) {
		throw new Error(`LIVE patch bundle file not found: ${LIVE_INTERACTIVE_MODE_PATH}`);
	}
	return file.text();
}

function decodeTsString(raw: string): string {
	let out = "";

	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}

		i += 1;
		const next = raw[i];
		if (!next) {
			out += "\\";
			break;
		}

		switch (next) {
			case "n":
				out += "\n";
				break;
			case "r":
				out += "\r";
				break;
			case "t":
				out += "\t";
				break;
			case "\\":
				out += "\\";
				break;
			case '"':
				out += '"';
				break;
			case "'":
				out += "'";
				break;
			case "x": {
				const hex = raw.slice(i + 1, i + 3);
				if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
					out += `\\x${hex}`;
					i += hex.length;
					break;
				}
				out += String.fromCharCode(Number.parseInt(hex, 16));
				i += 2;
				break;
			}
			case "u": {
				if (raw[i + 1] === "{") {
					const close = raw.indexOf("}", i + 2);
					if (close === -1) {
						out += "\\u{";
						break;
					}
					const codePointHex = raw.slice(i + 2, close);
					const codePoint = Number.parseInt(codePointHex, 16);
					if (Number.isNaN(codePoint)) {
						out += `\\u{${codePointHex}}`;
					} else {
						out += String.fromCodePoint(codePoint);
					}
					i = close;
					break;
				}

				const hex = raw.slice(i + 1, i + 5);
				if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
					out += `\\u${hex}`;
					i += hex.length;
					break;
				}
				out += String.fromCharCode(Number.parseInt(hex, 16));
				i += 4;
				break;
			}
			default:
				out += next;
		}
	}

	return out;
}

function extractActionButtonsBlock(source: string): string {
	const marker = "const ACTION_BUTTONS: ActionButtonUi[] = [";
	const markerStart = source.indexOf(marker);
	if (markerStart === -1) {
		throw new Error("ACTION_BUTTONS constant was not found in interactive-mode source");
	}

	const arrayStart = markerStart + marker.length - 1;
	if (arrayStart === -1) {
		throw new Error("ACTION_BUTTONS opening [ was not found");
	}

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = arrayStart; i < source.length; i += 1) {
		const char = source[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "[") {
			depth += 1;
			continue;
		}
		if (char === "]") {
			depth -= 1;
			if (depth === 0) {
				return source.slice(arrayStart + 1, i);
			}
		}
	}

	throw new Error("ACTION_BUTTONS closing ] was not found");
}

function splitButtonObjects(arrayBody: string): string[] {
	const objects: string[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let objectStart = -1;

	for (let i = 0; i < arrayBody.length; i += 1) {
		const char = arrayBody[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) {
				objectStart = i;
			}
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0 && objectStart >= 0) {
				objects.push(arrayBody.slice(objectStart, i + 1));
				objectStart = -1;
			}
		}
	}

	return objects;
}

function extractQuotedField(objectSource: string, field: string): string {
	const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = objectSource.match(new RegExp(`${escapedField}:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"));
	if (!match?.[1]) {
		throw new Error(`Failed to parse ${field} from ACTION_BUTTONS entry:\n${objectSource}`);
	}
	return decodeTsString(match[1]);
}

function extractOptionalQuotedField(objectSource: string, field: string): string | undefined {
	const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = objectSource.match(new RegExp(`${escapedField}:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"));
	return match?.[1] ? decodeTsString(match[1]) : undefined;
}

function extractStatusKey(objectSource: string): string {
	const match = objectSource.match(/statusKey:\s*([A-Z_]+)/);
	if (!match?.[1]) {
		throw new Error(`Failed to parse statusKey from ACTION_BUTTONS entry:\n${objectSource}`);
	}
	return match[1];
}

function extractActionButtons(source: string): ParsedActionButton[] {
	const arrayBody = extractActionButtonsBlock(source);
	const objects = splitButtonObjects(arrayBody);

	if (objects.length === 0) {
		throw new Error("ACTION_BUTTONS array was found but no button entries were parsed");
	}

	return objects.map(objectSource => ({
		label: extractQuotedField(objectSource, "label"),
		command: extractQuotedField(objectSource, "command"),
		statusKey: extractStatusKey(objectSource),
		normalText: extractQuotedField(objectSource, "normalText"),
		hoverText: extractQuotedField(objectSource, "hoverText"),
		editorText: extractOptionalQuotedField(objectSource, "editorText"),
	}));
}

describe("footer ACTION_BUTTONS regression lock", () => {
	test("locks footer labels, colorized text, and critical prompt strings", async () => {
		const source = await readLiveInteractiveSource();
		const buttons = extractActionButtons(source);
		const byLabel = new Map(buttons.map(button => [button.label, button]));

		const missingRequiredLabels = REQUIRED_LABELS.filter(label => !byLabel.has(label));
		if (missingRequiredLabels.length > 0) {
			throw new Error(`Missing required footer button labels: ${missingRequiredLabels.join(", ")}`);
		}

		for (const expected of EXPECTED_BUTTON_STYLES) {
			const actual = byLabel.get(expected.label);
			expect(actual).toBeDefined();
			expect(actual?.command).toBe(expected.command);
			expect(actual?.normalText).toBe(expected.normalText);
			expect(actual?.hoverText).toBe(expected.hoverText);
		}

		const planReviewButton = byLabel.get("Plan Review");
		if (!planReviewButton) {
			throw new Error("Plan Review button was not found in ACTION_BUTTONS");
		}
		expect(planReviewButton.editorText).toBe(EXPECTED_PLAN_REVIEW_EDITOR_TEXT);

		const fixPlanButton = byLabel.get("Fix Plan");
		if (!fixPlanButton) {
			throw new Error("Fix Plan button was not found in ACTION_BUTTONS");
		}
		expect(fixPlanButton.editorText).toBe(EXPECTED_FIX_PLAN_EDITOR_TEXT);
	});
});
