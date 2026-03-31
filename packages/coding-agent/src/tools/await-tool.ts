import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import awaitDescription from "../prompts/tools/await.md" with { type: "text" };
import type { ToolSession } from "./index";

/** How often to poll for stalled jobs when no job has completed yet. */
const STALL_POLL_INTERVAL_MS = 15_000;

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
	/** True when this job was automatically cancelled because it produced no progress for the stall threshold. */
	stalledAndCancelled?: boolean;
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

		// Jobs already finished before we started — return immediately
		const stalledJobIds = new Set<string>();
		if (jobsToWatch.every(j => j.status !== "running")) {
			return this.#buildResult(manager, jobsToWatch, stalledJobIds);
		}

		const stallThresholdSeconds = this.session.settings.get("async.stallThresholdSeconds");
		const stallThresholdMs = stallThresholdSeconds > 0 ? stallThresholdSeconds * 1000 : 0;

		const callStartMs = Date.now();
		const callTimeoutMs = params.timeout != null && params.timeout > 0 ? params.timeout * 1000 : undefined;

		// Shared abort promise so we can break the inner race when the caller's signal fires.
		const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<void>();
		const onAbort = () => resolveAbort();
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			while (true) {
				// Exit: all jobs either finished or were stall-cancelled by us
				const activeJobs = jobsToWatch.filter(j => j.status === "running" && !stalledJobIds.has(j.id));
				if (activeJobs.length === 0) break;

				// Exit: caller aborted
				if (signal?.aborted) break;

				// Exit: user-specified wall-clock timeout elapsed
				const elapsedMs = Date.now() - callStartMs;
				if (callTimeoutMs !== undefined && elapsedMs >= callTimeoutMs) break;

				// Sleep until the next poll tick or the remaining call timeout, whichever is shorter.
				// Short-circuits immediately if a job finishes or the abort fires.
				const remainingTimeoutMs =
					callTimeoutMs !== undefined ? Math.max(0, callTimeoutMs - elapsedMs) : undefined;
				const sleepMs =
					remainingTimeoutMs !== undefined
						? Math.min(STALL_POLL_INTERVAL_MS, remainingTimeoutMs)
						: STALL_POLL_INTERVAL_MS;

				const { promise: sleepPromise, resolve: sleepResolve } = Promise.withResolvers<void>();
				const sleepTimer = setTimeout(sleepResolve, sleepMs);
				try {
					await Promise.race([...activeJobs.map(j => j.promise), sleepPromise, abortPromise]);
				} finally {
					clearTimeout(sleepTimer);
				}

				// Stall detection: cancel task jobs that have produced no progress within the threshold.
				if (stallThresholdMs > 0) {
					const now = Date.now();
					for (const job of jobsToWatch) {
						if (job.status !== "running" || job.type !== "task" || stalledJobIds.has(job.id)) continue;
						// Fall back to startTime when no progress snapshot has been received yet.
						const lastProgress = job.lastProgressAt ?? job.startTime;
						if (now - lastProgress >= stallThresholdMs) {
							manager.cancel(job.id);
							stalledJobIds.add(job.id);
						}
					}
				}

				// Preserve the original "return as soon as at least one non-stalled job finishes" contract.
				const anyNonStalledFinished = jobsToWatch.some(
					j => j.status !== "running" && !stalledJobIds.has(j.id),
				);
				if (anyNonStalledFinished || signal?.aborted) break;

				// All remaining active jobs are stalled — nothing left to wait for.
				const anyStillActive = jobsToWatch.some(
					j => j.status === "running" && !stalledJobIds.has(j.id),
				);
				if (!anyStillActive) break;

				// Poll timer fired with no stalls and no completions — continue waiting.
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}

		return this.#buildResult(manager, jobsToWatch, stalledJobIds);
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
		stalledJobIds: Set<string>,
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
			...(stalledJobIds.has(j.id) ? { stalledAndCancelled: true } : {}),
		}));

		// Only acknowledge delivery for jobs that finished on their own (not stall-cancelled).
		manager.acknowledgeDeliveries(
			jobResults
				.filter(j => j.status !== "running" && !j.stalledAndCancelled)
				.map(j => j.id),
		);

		const stalled = jobResults.filter(j => j.stalledAndCancelled);
		const completed = jobResults.filter(j => j.status !== "running" && !j.stalledAndCancelled);
		const running = jobResults.filter(j => j.status === "running" && !j.stalledAndCancelled);

		const lines: string[] = [];

		if (stalled.length > 0) {
			lines.push(`## Stalled — Auto-Cancelled (${stalled.length})\n`);
			lines.push(
				"⚠ These jobs produced no progress for the configured stall threshold and have been cancelled automatically. Resubmit them.\n",
			);
			for (const j of stalled) {
				lines.push(`### \`${j.id}\` [${j.type}]`);
				lines.push(`Label: ${j.label}`);
				lines.push(`Duration: ${Math.round(j.durationMs / 1000)}s`);
				lines.push("");
			}
		}

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
						if (extracted?.task) {
							for (const nestedTask of extracted.task) {
								const nt = nestedTask as {
									results?: Array<{ agent?: string; id?: string; exitCode?: number }>;
								};
								if (nt.results) {
									for (const nr of nt.results) {
										lines.push(
											`    - nested ${nr.agent ?? "agent"} (${nr.id ?? "?"}): exit=${nr.exitCode ?? "?"}`,
										);
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
