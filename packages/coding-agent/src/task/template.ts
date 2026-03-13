import { renderPromptTemplate } from "../config/prompt-templates";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import type { TaskItem } from "./types";

interface RenderResult {
	/** Full task text sent to the subagent */
	task: string;
	id: string;
	description: string;
}

export interface RenderTemplateOptions {
	delegationContext?: string;
}

function buildBackground(context: string | undefined, delegationContext: string | undefined): string | undefined {
	const parts = [delegationContext?.trim(), context?.trim()].filter((value): value is string => Boolean(value));
	if (parts.length === 0) return undefined;
	return parts.join("\n\n");
}

/**
 * Build the full task text from delegation metadata, shared context, and assignment text.
 */
export function renderTemplate(
	context: string | undefined,
	task: TaskItem,
	options: RenderTemplateOptions = {},
): RenderResult {
	let { id, description, assignment } = task;
	assignment = assignment.trim();
	const background = buildBackground(context, options.delegationContext);

	if (!background || !assignment) {
		return { task: assignment || background!, id, description };
	}
	return {
		task: renderPromptTemplate(subagentUserPromptTemplate, { context: background, assignment }),
		id,
		description,
	};
}
