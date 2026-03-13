import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import awaitDescription from "../prompts/tools/await.md" with { type: "text" };
import type { ToolSession } from "./index";

const awaitSchema = Type.Object({
	jobs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Specific job IDs to wait for. If omitted, waits for any running job.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Maximum seconds to wait. If the timeout expires before jobs complete, returns current status without aborting the jobs. Jobs keep running in the background.",
		}),
	),
});

type AwaitParams = Static<typeof awaitSchema>;

interface AwaitResult {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

export interface AwaitToolDetails {
	jobs: AwaitResult[];
}

export class AwaitTool implements AgentTool<typeof awaitSchema, AwaitToolDetails> {
	readonly name = "await";
	readonly label = "Await";
	readonly description: string;
	readonly parameters = awaitSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = renderPromptTemplate(awaitDescription);
	}

	static createIf(session: ToolSession): AwaitTool | null {
		if (!session.settings.get("async.enabled")) return null;
		return new AwaitTool(session);
	}

	async execute(
		_toolCallId: string,
		params: AwaitParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AwaitToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AwaitToolDetails>> {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs to poll." }],
				details: { jobs: [] },
			};
		}

		const requestedIds = params.jobs;

		// Resolve which jobs to watch
		const jobsToWatch = requestedIds?.length
			? requestedIds.map(id => manager.getJob(id)).filter(j => j != null)
			: manager.getRunningJobs();

		if (jobsToWatch.length === 0) {
			const message = requestedIds?.length
				? `No matching jobs found for IDs: ${requestedIds.join(", ")}`
				: "No running background jobs to wait for.";
			return {
				content: [{ type: "text", text: message }],
				details: { jobs: [] },
			};
		}

		// If all watched jobs are already done, return immediately
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			return this.#buildResult(manager, jobsToWatch);
		}

		// Block until at least one running job finishes, timeout expires, or the call is aborted
		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);

		// Add timeout promise if specified (non-destructive: jobs keep running)
		let timeoutId: NodeJS.Timeout | undefined;
		const timeoutMs = params.timeout != null && params.timeout > 0 ? params.timeout * 1000 : undefined;
		if (timeoutMs) {
			const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
			timeoutId = setTimeout(timeoutResolve, timeoutMs);
			racePromises.push(timeoutPromise);
		}

		if (signal) {
			const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
			const onAbort = () => abortResolve();
			signal.addEventListener("abort", onAbort, { once: true });
			racePromises.push(abortPromise);
			try {
				await Promise.race(racePromises);
			} finally {
				signal.removeEventListener("abort", onAbort);
				if (timeoutId) clearTimeout(timeoutId);
			}
		} else {
			try {
				await Promise.race(racePromises);
			} finally {
				if (timeoutId) clearTimeout(timeoutId);
			}
		}

		if (signal?.aborted) {
			return this.#buildResult(manager, jobsToWatch);
		}

		return this.#buildResult(manager, jobsToWatch);
	}

	#buildResult(
		manager: NonNullable<ToolSession["asyncJobManager"]>,
		jobs: {
			id: string;
			type: "bash" | "task";
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
			progressSnapshot?: Record<string, unknown>;
		}[],
	): AgentToolResult<AwaitToolDetails> {
		const now = Date.now();
		const jobResults: AwaitResult[] = jobs.map(j => ({
			id: j.id,
			type: j.type,
			status: j.status as AwaitResult["status"],
			label: j.label,
			durationMs: Math.max(0, now - j.startTime),
			...(j.resultText ? { resultText: j.resultText } : {}),
			...(j.errorText ? { errorText: j.errorText } : {}),
		}));

		manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

		const completed = jobResults.filter(j => j.status !== "running");
		const running = jobResults.filter(j => j.status === "running");

		const lines: string[] = [];
		if (completed.length > 0) {
			lines.push(`## Completed (${completed.length})\n`);
			for (const j of completed) {
				lines.push(`### ${j.id} [${j.type}] \u2014 ${j.status}`);
				lines.push(`Label: ${j.label}`);
				if (j.resultText) {
					lines.push("```", j.resultText, "```");
				}
				if (j.errorText) {
					lines.push(`Error: ${j.errorText}`);
				}
				lines.push("");
			}
		}

		if (running.length > 0) {
			lines.push(`## Still Running (${running.length})\n`);
			for (const j of running) {
				const job = jobs.find(raw => raw.id === j.id);
				lines.push(`### \`${j.id}\` [${j.type}] \u2014 ${j.label}`);
				lines.push(`Duration: ${Math.round(j.durationMs / 1000)}s`);

				// Include progress snapshot for running task jobs (nested subagent visibility)
				const snapshot = job?.progressSnapshot as { progress?: Array<Record<string, unknown>> } | undefined;
				if (snapshot?.progress && Array.isArray(snapshot.progress)) {
					for (const p of snapshot.progress) {
						const agent = p.agent ?? "unknown";
						const status = p.status ?? "unknown";
						const currentTool = p.currentTool ? ` (running: ${p.currentTool})` : "";
						const lastIntent = p.lastIntent ? ` \u2014 ${p.lastIntent}` : "";
						const tools = typeof p.toolCount === "number" ? ` [${p.toolCount} tools]` : "";
						lines.push(`  - ${agent}: ${status}${currentTool}${tools}${lastIntent}`);

						// Show nested subagent data if available
						const extracted = p.extractedToolData as Record<string, unknown[]> | undefined;
						if (extracted?.["task"]) {
							for (const nestedTask of extracted["task"]) {
								const nt = nestedTask as { results?: Array<{ agent?: string; id?: string; exitCode?: number }> };
								if (nt.results) {
									for (const nr of nt.results) {
										lines.push(`    - nested ${nr.agent ?? "agent"} (${nr.id ?? "?"}): exit=${nr.exitCode ?? "?"}`);
									}
								}
							}
						}
					}
				}
				lines.push("");
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { jobs: jobResults },
		};
	}
}
