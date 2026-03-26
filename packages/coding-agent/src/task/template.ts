import { renderPromptTemplate } from "../config/prompt-templates";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import type { TaskItem } from "./types";

export interface RenderResult {
	/** Full task text sent to the subagent */
	task: string;
	/** Raw per-task assignment text, without prompt template boilerplate */
	assignment: string;
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
	const directContext = context?.trim();
	if (directContext?.startsWith("delegation:")) {
		return { task: directContext, assignment: directContext, id, description };
	}
	const delegationContext = options.delegationContext?.trim();
	if (delegationContext?.startsWith("delegation:")) {
		const outerContext = context?.trim();
		if (!outerContext) {
			// No outer context — TOON is the complete prompt
			return { task: delegationContext, assignment: delegationContext, id, description };
		}
		// Outer context present — append it after the TOON so the subagent sees both.
		// This preserves the documented task tool contract: context is "prepended to every task's assignment".
		const combined = `${delegationContext}\n\n${outerContext}`;
		return { task: combined, assignment: delegationContext, id, description };
	}
	const background = buildBackground(context, options.delegationContext);
	if (!background || !assignment) {
		return { task: assignment || background || "", assignment: assignment || background || "", id, description };
	}
	return {
		task: renderPromptTemplate(subagentUserPromptTemplate, { context: background, assignment }),
		assignment,
		id,
		description,
	};
}
