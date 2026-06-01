/**
 * Streaming-safe filters for leaked chat-template tool-call and thinking markup.
 *
 * Hosted models sometimes leak raw template markup into visible `content` instead
 * of returning structured events. One `StreamMarkupHealing` instance owns one stream
 * and one grammar selected by options:
 *
 * - `kimi`: Kimi K2 `<|tool_calls_section_begin|>` sections.
 * - `dsml`: DeepSeek `<｜DSML｜tool_calls>` envelopes.
 * - `thinking`: plain `<think>` / `<thinking>` blocks used by MiniMax-style streams.
 *
 * The parser strips marker bytes, reconstructs embedded calls, emits thinking
 * deltas for thinking blocks, and holds partial tags across chunk boundaries.
 */

import { parseJsonWithRepair } from "./json-parse";

const KIMI_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const KIMI_SECTION_END = "<|tool_calls_section_end|>";
const KIMI_CALL_BEGIN = "<|tool_call_begin|>";
const KIMI_CALL_END = "<|tool_call_end|>";
const KIMI_ARG_BEGIN = "<|tool_call_argument_begin|>";
const KIMI_TOKENS = [KIMI_SECTION_BEGIN, KIMI_SECTION_END, KIMI_CALL_BEGIN, KIMI_CALL_END, KIMI_ARG_BEGIN] as const;

/** Maximum buffered Kimi partial-token length before giving up holdback. */
const MAX_KIMI_PARTIAL_HOLD = 64;

/** Both fullwidth (U+FF5C) and ASCII pipes are observed in DeepSeek DSML leaks. */
const DSML_PIPE = "[｜|]";
const DSML_TOOL_CALLS_OPEN_RE = new RegExp(`<${DSML_PIPE}DSML${DSML_PIPE}tool_calls>`, "y");
const DSML_TOOL_CALLS_CLOSE_RE = new RegExp(`</${DSML_PIPE}DSML${DSML_PIPE}tool_calls>`, "y");
const DSML_INVOKE_OPEN_RE = new RegExp(`<${DSML_PIPE}DSML${DSML_PIPE}invoke\\s+name="([^"]*)"\\s*>`, "y");
const DSML_INVOKE_CLOSE_RE = new RegExp(`</${DSML_PIPE}DSML${DSML_PIPE}invoke>`, "y");
const DSML_PARAMETER_OPEN_RE = new RegExp(
	`<${DSML_PIPE}DSML${DSML_PIPE}parameter\\s+name="([^"]*)"(?:\\s+string="(true|false)")?\\s*>`,
	"y",
);
const DSML_PARAMETER_CLOSE_RE = new RegExp(`</${DSML_PIPE}DSML${DSML_PIPE}parameter>`, "y");

const TAG_CLAUDE_INTERNAL_OPEN = "<claude_internal>";
const TAG_CLAUDE_INTERNAL_CLOSE = "</claude_internal>";
const TAG_FUNCTION_CALLS_OPEN = "<function_calls>";
const TAG_FUNCTION_CALLS_CLOSE = "</function_calls>";
const TAG_TOOL_CALL_OPEN = "<tool_call>";
const TAG_TOOL_CALL_CLOSE = "</tool_call>";
const TAG_TOOL_NAME_OPEN = "<tool_name>";
const TAG_TOOL_NAME_CLOSE = "</tool_name>";
const TAG_TOOL_PARAMETERS_OPEN = "<tool_parameters>";
const TAG_TOOL_PARAMETERS_CLOSE = "</tool_parameters>";
const TAG_INVOKE_CLOSE = "</invoke>";
const TAG_PARAMETER_OPEN = "<parameter";
const TAG_PARAMETER_CLOSE = "</parameter>";

const XML_HEAL_OPEN_PREFIXES = [
	TAG_CLAUDE_INTERNAL_OPEN,
	TAG_FUNCTION_CALLS_OPEN,
	TAG_TOOL_CALL_OPEN,
	"<invoke",
	"<｜DSML｜tool_calls>",
	"<|DSML|tool_calls>",
] as const;

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

const PLAIN_THINKING_TAGS = [
	{ open: THINK_OPEN, close: THINK_CLOSE },
	{ open: THINKING_OPEN, close: THINKING_CLOSE },
] as const;

/** Cap held-back XML tag bytes so a stray `<` in prose cannot grow unboundedly. */
const MAX_XML_PARTIAL_HOLD = 256;

/** Maximum parameter bytes to accumulate before abandoning a pathological XML call. */
const MAX_XML_PARAM_VALUE_LENGTH = 1_000_000;

export interface HealedToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

export type StreamMarkupHealingPattern = "kimi" | "dsml" | "thinking" | "xml";

export interface StreamMarkupHealingOptions {
	readonly pattern: StreamMarkupHealingPattern;
	readonly toolNames?: ReadonlySet<string>;
}

export type StreamMarkupHealingEvent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "thinking"; readonly thinking: string }
	| { readonly type: "toolCall"; readonly call: HealedToolCall };

type XmlToolState =
	| { readonly kind: "idle" }
	| { readonly kind: "section" }
	| { readonly kind: "invoke"; readonly name: string; readonly args: Record<string, unknown> }
	| {
			readonly kind: "parameter";
			readonly invokeName: string;
			readonly args: Record<string, unknown>;
			readonly paramName: string;
			readonly isString: boolean;
			value: string;
	  };

type XmlEnvelopeKind = "claude_internal" | "function_calls" | "invoke" | "tool_call" | "dsml_fullwidth" | "dsml_ascii";

type ActiveXmlEnvelope = { readonly kind: XmlEnvelopeKind } | { readonly kind: "bare_tool"; readonly toolName: string };

type XmlEnvelopeStatus = "complete" | "incomplete" | "no_match";

interface XmlEnvelopeParse {
	readonly status: XmlEnvelopeStatus;
	readonly consumed: number;
	readonly calls: readonly HealedToolCall[];
}

type ThinkingTag = { readonly open: string; readonly close: string };

/**
 * State machine that consumes streamed visible text and emits cleaned text,
 * thinking deltas, and reconstructed tool calls.
 *
 * Feed only one stream channel (usually `delta.content` / `message.content`).
 * Mixing reasoning and visible text into the same instance can corrupt the
 * held-back partial tag buffer.
 */
export class StreamMarkupHealing {
	readonly #pattern: StreamMarkupHealingPattern;
	#buffer = "";
	#offset = 0;

	#kimiInSection = false;
	#kimiInCall = false;
	#kimiInArgs = false;
	#kimiPendingId = "";
	#kimiPendingArgs = "";

	#xmlState: XmlToolState = { kind: "idle" };
	#activeXmlEnvelope: ActiveXmlEnvelope | undefined;
	#thinkingCloseTag = "";
	#sectionTerminated = false;
	readonly #completed: HealedToolCall[] = [];
	readonly #bareToolNames: readonly string[];

	constructor(options: StreamMarkupHealingOptions) {
		this.#pattern = options.pattern;
		this.#bareToolNames = normalizeAllowedToolNames(options.toolNames);
	}

	get pattern(): StreamMarkupHealingPattern {
		return this.#pattern;
	}

	/**
	 * Feed a chunk and return visible text only. Reconstructed tool calls are
	 * stored for {@link drainCompleted}; thinking blocks are intentionally not
	 * returned by this compatibility helper. Use {@link feedEvents} when the
	 * caller needs ordered text/thinking/tool-call events.
	 */
	feed(text: string): string {
		let clean = "";
		for (const event of this.feedEvents(text)) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/** Feed a chunk and return cleaned text/thinking/tool-call events in stream order. */
	feedEvents(text: string): StreamMarkupHealingEvent[] {
		if (text.length === 0) return [];
		this.#compact();
		this.#buffer += text;
		switch (this.#pattern) {
			case "kimi":
				return this.#consumeKimiEvents();
			case "dsml":
				return this.#consumeDsmlEvents();
			case "thinking":
				return this.#consumePlainThinkingEvents();
			case "xml":
				return this.#consumeGenericXmlEvents();
		}
	}

	/**
	 * Like {@link feed}, but discards completed calls. Used when the upstream
	 * chunk also carries structured `tool_calls`, keeping that structured payload
	 * as the single source of truth.
	 */
	consumeWithoutCalls(text: string): string {
		let clean = "";
		for (const event of this.feedEvents(text)) {
			if (event.type === "text") clean += event.text;
		}
		return clean;
	}

	/** Drain accumulated tool calls from calls to {@link feed}. */
	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush held-back stream-end fragments as ordered events. Partial tool-call
	 * sections/envelopes are dropped; unterminated thinking blocks are emitted as
	 * thinking, matching the previous MiniMax parser behavior.
	 */
	flushEvents(): StreamMarkupHealingEvent[] {
		const tail = this.#remaining();
		this.#buffer = "";
		this.#offset = 0;

		switch (this.#pattern) {
			case "kimi": {
				const inTemplate = this.#kimiInCall || this.#kimiInSection;
				this.#resetKimi();
				return inTemplate || tail.length === 0 ? [] : [{ type: "text", text: tail }];
			}
			case "dsml": {
				const state = this.#xmlState;
				this.#xmlState = { kind: "idle" };
				return state.kind !== "idle" || tail.length === 0 ? [] : [{ type: "text", text: tail }];
			}
			case "thinking": {
				const closeTag = this.#thinkingCloseTag;
				this.#thinkingCloseTag = "";
				if (tail.length === 0) return [];
				return closeTag ? [{ type: "thinking", thinking: tail }] : [{ type: "text", text: tail }];
			}
			case "xml": {
				const activeEnvelope = this.#activeXmlEnvelope;
				this.#activeXmlEnvelope = undefined;
				if (tail.length === 0) return [];
				if (!activeEnvelope || shouldPreserveIncompleteEnvelopeTail(activeEnvelope, tail)) {
					return [{ type: "text", text: tail }];
				}
				return [];
			}
		}
	}

	/** Flush held-back text only. Reconstructed calls are retained for {@link drainCompleted}. */
	flushPending(): string {
		let clean = "";
		for (const event of this.flushEvents()) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/** True once any configured tool-call section/envelope has fully closed. */
	get sectionClosed(): boolean {
		return this.#sectionTerminated;
	}

	#remaining(): string {
		return this.#offset === 0 ? this.#buffer : this.#buffer.slice(this.#offset);
	}

	#compact(): void {
		if (this.#offset === 0) return;
		this.#buffer = this.#buffer.slice(this.#offset);
		this.#offset = 0;
	}

	#consumeKimiEvents(): StreamMarkupHealingEvent[] {
		const events: StreamMarkupHealingEvent[] = [];
		let clean = "";
		const flushClean = (): void => {
			if (clean.length === 0) return;
			events.push({ type: "text", text: clean });
			clean = "";
		};

		while (this.#offset < this.#buffer.length) {
			if (this.#startsWithPartialToken(KIMI_TOKENS, MAX_KIMI_PARTIAL_HOLD)) break;

			if (this.#matchesToken(KIMI_SECTION_BEGIN)) {
				this.#kimiInSection = true;
				this.#offset += KIMI_SECTION_BEGIN.length;
				continue;
			}
			if (this.#matchesToken(KIMI_SECTION_END)) {
				this.#kimiInSection = false;
				this.#sectionTerminated = true;
				this.#offset += KIMI_SECTION_END.length;
				continue;
			}
			if (this.#matchesToken(KIMI_CALL_BEGIN)) {
				if (!this.#kimiInSection) {
					clean += KIMI_CALL_BEGIN;
					this.#offset += KIMI_CALL_BEGIN.length;
					continue;
				}
				this.#kimiInCall = true;
				this.#kimiInArgs = false;
				this.#kimiPendingId = "";
				this.#kimiPendingArgs = "";
				this.#offset += KIMI_CALL_BEGIN.length;
				continue;
			}
			if (this.#matchesToken(KIMI_ARG_BEGIN)) {
				if (!this.#kimiInSection) {
					clean += KIMI_ARG_BEGIN;
					this.#offset += KIMI_ARG_BEGIN.length;
					continue;
				}
				this.#kimiInArgs = true;
				this.#offset += KIMI_ARG_BEGIN.length;
				continue;
			}
			if (this.#matchesToken(KIMI_CALL_END)) {
				if (!this.#kimiInSection || !this.#kimiInCall) {
					clean += KIMI_CALL_END;
					this.#offset += KIMI_CALL_END.length;
					continue;
				}
				const call = this.#finalizeKimiCall();
				flushClean();
				events.push({ type: "toolCall", call });
				this.#offset += KIMI_CALL_END.length;
				continue;
			}

			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;

			if (this.#kimiInCall) {
				if (this.#kimiInArgs) {
					this.#kimiPendingArgs += ch;
				} else {
					this.#kimiPendingId += ch;
				}
				continue;
			}

			if (!this.#kimiInSection) clean += ch;
		}

		flushClean();
		return events;
	}

	#consumeDsmlEvents(): StreamMarkupHealingEvent[] {
		return this.#consumeXmlToolEvents({
			getState: () => this.#xmlState,
			setState: state => {
				this.#xmlState = state;
			},
			sectionOpen: DSML_TOOL_CALLS_OPEN_RE,
			sectionClose: DSML_TOOL_CALLS_CLOSE_RE,
			invokeOpen: DSML_INVOKE_OPEN_RE,
			invokeClose: DSML_INVOKE_CLOSE_RE,
			parameterOpen: DSML_PARAMETER_OPEN_RE,
			parameterClose: DSML_PARAMETER_CLOSE_RE,
			coerceStringByDefault: true,
		});
	}

	#consumeGenericXmlEvents(): StreamMarkupHealingEvent[] {
		const events: StreamMarkupHealingEvent[] = [];
		let clean = "";
		const flushClean = (): void => {
			if (clean.length === 0) return;
			events.push({ type: "text", text: clean });
			clean = "";
		};

		while (this.#offset < this.#buffer.length) {
			if (!this.#activeXmlEnvelope) {
				const openIndex = this.#findNextGenericXmlOpen();
				if (openIndex < 0) {
					const tail = this.#remaining();
					const holdLength = getTrailingPartialXmlOpenLength(tail, this.#bareToolNames);
					const flushLength = tail.length - holdLength;
					if (flushLength > 0) {
						clean += tail.slice(0, flushLength);
						this.#offset += flushLength;
					}
					break;
				}

				if (openIndex > this.#offset) {
					clean += this.#buffer.slice(this.#offset, openIndex);
					this.#offset = openIndex;
				}

				const beginStatus = this.#beginGenericXmlEnvelope();
				if (beginStatus === "incomplete") break;
				if (beginStatus === "no_match") {
					clean += this.#buffer[this.#offset]!;
					this.#offset += 1;
				}
				continue;
			}

			const parsed = this.#parseActiveGenericXmlEnvelope();
			if (parsed.status === "incomplete") break;
			if (parsed.status === "no_match") {
				this.#activeXmlEnvelope = undefined;
				clean += this.#buffer[this.#offset]!;
				this.#offset += 1;
				continue;
			}
			flushClean();
			for (const call of parsed.calls) events.push({ type: "toolCall", call });
			this.#offset += parsed.consumed;
			this.#activeXmlEnvelope = undefined;
			this.#sectionTerminated = true;
		}

		flushClean();
		return events;
	}

	#findNextGenericXmlOpen(): number {
		const candidates = [
			this.#buffer.indexOf(TAG_CLAUDE_INTERNAL_OPEN, this.#offset),
			this.#buffer.indexOf(TAG_FUNCTION_CALLS_OPEN, this.#offset),
			this.#buffer.indexOf(TAG_TOOL_CALL_OPEN, this.#offset),
			this.#buffer.indexOf("<invoke", this.#offset),
			this.#buffer.indexOf("<｜DSML｜tool_calls>", this.#offset),
			this.#buffer.indexOf("<|DSML|tool_calls>", this.#offset),
		];
		let min = -1;
		for (const candidate of candidates) min = minOpenIndex(min, candidate);
		for (const toolName of this.#bareToolNames) {
			min = minOpenIndex(min, findBareToolOpen(this.#buffer, this.#offset, toolName));
		}
		return min;
	}

	#beginGenericXmlEnvelope(): XmlEnvelopeStatus {
		if (this.#buffer.startsWith("<｜DSML｜tool_calls>", this.#offset)) {
			this.#activeXmlEnvelope = { kind: "dsml_fullwidth" };
			return "complete";
		}
		if (this.#buffer.startsWith("<|DSML|tool_calls>", this.#offset)) {
			this.#activeXmlEnvelope = { kind: "dsml_ascii" };
			return "complete";
		}
		if (this.#buffer.startsWith(TAG_CLAUDE_INTERNAL_OPEN, this.#offset)) {
			this.#activeXmlEnvelope = { kind: "claude_internal" };
			return "complete";
		}
		if (this.#buffer.startsWith(TAG_FUNCTION_CALLS_OPEN, this.#offset)) {
			this.#activeXmlEnvelope = { kind: "function_calls" };
			return "complete";
		}
		if (this.#buffer.startsWith(TAG_TOOL_CALL_OPEN, this.#offset)) {
			this.#activeXmlEnvelope = { kind: "tool_call" };
			return "complete";
		}
		if (this.#buffer.startsWith("<invoke", this.#offset)) {
			const boundaryIndex = this.#offset + "<invoke".length;
			const boundary = this.#buffer[boundaryIndex];
			if (boundary === undefined) return "incomplete";
			if (!isXmlTagNameBoundary(boundary)) return "no_match";
			this.#activeXmlEnvelope = { kind: "invoke" };
			return "complete";
		}
		for (const toolName of this.#bareToolNames) {
			const openTag = `<${toolName}`;
			if (!this.#buffer.startsWith(openTag, this.#offset)) continue;
			const boundary = this.#buffer[this.#offset + openTag.length];
			if (boundary === undefined) return "incomplete";
			if (!isXmlTagNameBoundary(boundary)) return "no_match";
			this.#activeXmlEnvelope = { kind: "bare_tool", toolName };
			return "complete";
		}
		return "no_match";
	}

	#parseActiveGenericXmlEnvelope(): XmlEnvelopeParse {
		if (!this.#activeXmlEnvelope) return { status: "no_match", consumed: 0, calls: [] };
		switch (this.#activeXmlEnvelope.kind) {
			case "dsml_fullwidth":
				return this.#parseStaticGenericXmlEnvelope(
					"<｜DSML｜tool_calls>",
					"</｜DSML｜tool_calls>",
					parseDsmlEnvelope,
				);
			case "dsml_ascii":
				return this.#parseStaticGenericXmlEnvelope("<|DSML|tool_calls>", "</|DSML|tool_calls>", parseDsmlEnvelope);
			case "claude_internal":
				return this.#parseStaticGenericXmlEnvelope(
					TAG_CLAUDE_INTERNAL_OPEN,
					TAG_CLAUDE_INTERNAL_CLOSE,
					parseClaudeInternalEnvelope,
				);
			case "function_calls":
				return this.#parseStaticGenericXmlEnvelope(
					TAG_FUNCTION_CALLS_OPEN,
					TAG_FUNCTION_CALLS_CLOSE,
					parseFunctionCallsEnvelope,
				);
			case "tool_call":
				return this.#parseStaticGenericXmlEnvelope(TAG_TOOL_CALL_OPEN, TAG_TOOL_CALL_CLOSE, parseToolCallEnvelope);
			case "invoke":
				return this.#parseInvokeEnvelope();
			case "bare_tool":
				return this.#parseBareToolEnvelope(this.#activeXmlEnvelope.toolName);
		}
	}

	#parseStaticGenericXmlEnvelope(
		openTag: string,
		closeTag: string,
		parse: (envelope: string) => readonly HealedToolCall[],
	): XmlEnvelopeParse {
		if (!this.#buffer.startsWith(openTag, this.#offset)) {
			return { status: "no_match", consumed: 0, calls: [] };
		}
		const closeIndex = this.#buffer.indexOf(closeTag, this.#offset + openTag.length);
		if (closeIndex < 0) return { status: "incomplete", consumed: 0, calls: [] };
		const consumed = closeIndex + closeTag.length - this.#offset;
		const envelope = this.#buffer.slice(this.#offset, this.#offset + consumed);
		return {
			status: "complete",
			consumed,
			calls: parse(envelope),
		};
	}

	#parseInvokeEnvelope(): XmlEnvelopeParse {
		if (!this.#buffer.startsWith("<invoke", this.#offset)) {
			return { status: "no_match", consumed: 0, calls: [] };
		}
		const openTagEnd = this.#buffer.indexOf(">", this.#offset + "<invoke".length);
		if (openTagEnd < 0) return { status: "incomplete", consumed: 0, calls: [] };
		const closeIndex = this.#buffer.indexOf(TAG_INVOKE_CLOSE, openTagEnd + 1);
		if (closeIndex < 0) return { status: "incomplete", consumed: 0, calls: [] };
		const consumed = closeIndex + TAG_INVOKE_CLOSE.length - this.#offset;
		const envelope = this.#buffer.slice(this.#offset, this.#offset + consumed);
		const call = parseSingleInvoke(envelope);
		return {
			status: "complete",
			consumed,
			calls: call ? [call] : [],
		};
	}

	#parseBareToolEnvelope(toolName: string): XmlEnvelopeParse {
		const openTag = `<${toolName}`;
		if (!this.#buffer.startsWith(openTag, this.#offset)) {
			return { status: "no_match", consumed: 0, calls: [] };
		}
		const boundary = this.#buffer[this.#offset + openTag.length];
		if (boundary === undefined) return { status: "incomplete", consumed: 0, calls: [] };
		if (!isXmlTagNameBoundary(boundary)) return { status: "no_match", consumed: 0, calls: [] };
		const openTagEnd = this.#buffer.indexOf(">", this.#offset + openTag.length);
		if (openTagEnd < 0) return { status: "incomplete", consumed: 0, calls: [] };
		const closeTag = `</${toolName}>`;
		const closeIndex = this.#buffer.indexOf(closeTag, openTagEnd + 1);
		if (closeIndex < 0) return { status: "incomplete", consumed: 0, calls: [] };
		const consumed = closeIndex + closeTag.length - this.#offset;
		const body = this.#buffer.slice(openTagEnd + 1, closeIndex);
		return {
			status: "complete",
			consumed,
			calls: [parseBareToolCall(toolName, body)],
		};
	}

	#consumePlainThinkingEvents(): StreamMarkupHealingEvent[] {
		const events: StreamMarkupHealingEvent[] = [];
		let clean = "";
		let thinking = "";
		const flushClean = (): void => {
			if (clean.length === 0) return;
			events.push({ type: "text", text: clean });
			clean = "";
		};
		const flushThinking = (): void => {
			if (thinking.length === 0) return;
			events.push({ type: "thinking", thinking });
			thinking = "";
		};

		while (this.#offset < this.#buffer.length) {
			if (this.#thinkingCloseTag) {
				if (this.#matchesToken(this.#thinkingCloseTag)) {
					flushThinking();
					this.#offset += this.#thinkingCloseTag.length;
					this.#thinkingCloseTag = "";
					continue;
				}
				if (this.#startsWithPartialToken([this.#thinkingCloseTag], MAX_XML_PARTIAL_HOLD)) break;
				const ch = this.#buffer[this.#offset]!;
				this.#offset += 1;
				thinking += ch;
				continue;
			}

			const thinkingTag = this.#tryMatchThinkingOpen(PLAIN_THINKING_TAGS);
			if (thinkingTag) {
				flushClean();
				this.#thinkingCloseTag = thinkingTag.close;
				continue;
			}
			if (this.#startsWithPartialThinkingOpen(PLAIN_THINKING_TAGS)) break;

			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;
			clean += ch;
		}

		flushClean();
		flushThinking();
		return events;
	}

	#consumeXmlToolEvents(config: {
		readonly getState: () => XmlToolState;
		readonly setState: (state: XmlToolState) => void;
		readonly sectionOpen: RegExp;
		readonly sectionClose: RegExp;
		readonly invokeOpen: RegExp;
		readonly invokeClose: RegExp;
		readonly parameterOpen: RegExp;
		readonly parameterClose: RegExp;
		readonly coerceStringByDefault: boolean;
	}): StreamMarkupHealingEvent[] {
		const events: StreamMarkupHealingEvent[] = [];
		let clean = "";
		const flushClean = (): void => {
			if (clean.length === 0) return;
			events.push({ type: "text", text: clean });
			clean = "";
		};

		while (this.#offset < this.#buffer.length) {
			const state = config.getState();

			if (state.kind === "idle") {
				if (this.#tryMatch(config.sectionOpen)) {
					config.setState({ kind: "section" });
					continue;
				}
			} else if (state.kind === "section") {
				if (this.#tryMatch(config.sectionClose)) {
					config.setState({ kind: "idle" });
					this.#sectionTerminated = true;
					continue;
				}
				const invokeMatch = this.#tryMatchCapture(config.invokeOpen);
				if (invokeMatch) {
					config.setState({ kind: "invoke", name: invokeMatch[1] ?? "", args: {} });
					continue;
				}
			} else if (state.kind === "invoke") {
				if (this.#tryMatch(config.invokeClose)) {
					const call = finalizeXmlToolCall(state.name, state.args);
					flushClean();
					events.push({ type: "toolCall", call });
					config.setState({ kind: "section" });
					continue;
				}
				const paramMatch = this.#tryMatchCapture(config.parameterOpen);
				if (paramMatch) {
					const stringAttr = paramMatch[2];
					config.setState({
						kind: "parameter",
						invokeName: state.name,
						args: state.args,
						paramName: paramMatch[1] ?? "",
						isString: config.coerceStringByDefault ? stringAttr !== "false" : false,
						value: "",
					});
					continue;
				}
			} else if (this.#tryMatch(config.parameterClose)) {
				state.args[state.paramName] = coerceXmlParamValue(state.value, state.isString);
				config.setState({ kind: "invoke", name: state.invokeName, args: state.args });
				continue;
			}

			if (this.#startsWithPartialXmlTag()) break;

			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;
			if (state.kind === "idle") {
				clean += ch;
				continue;
			}
			if (state.kind === "parameter") {
				if (state.value.length >= MAX_XML_PARAM_VALUE_LENGTH) {
					config.setState({ kind: "idle" });
					continue;
				}
				state.value += ch;
			}
		}

		flushClean();
		return events;
	}

	#tryMatch(pattern: RegExp): boolean {
		pattern.lastIndex = this.#offset;
		const match = pattern.exec(this.#buffer);
		if (!match) return false;
		this.#offset += match[0].length;
		return true;
	}

	#tryMatchCapture(pattern: RegExp): RegExpExecArray | undefined {
		pattern.lastIndex = this.#offset;
		const match = pattern.exec(this.#buffer);
		if (!match) return undefined;
		this.#offset += match[0].length;
		return match;
	}

	#tryMatchThinkingOpen(tags: readonly ThinkingTag[]): ThinkingTag | undefined {
		for (const tag of tags) {
			if (!this.#matchesToken(tag.open)) continue;
			this.#offset += tag.open.length;
			return tag;
		}
		return undefined;
	}

	#matchesToken(token: string): boolean {
		return this.#buffer.startsWith(token, this.#offset);
	}

	#startsWithPartialThinkingOpen(tags: readonly ThinkingTag[]): boolean {
		for (const tag of tags) {
			if (this.#startsWithPartialToken([tag.open], MAX_XML_PARTIAL_HOLD)) return true;
		}
		return false;
	}

	#startsWithPartialToken(tokens: readonly string[], maxHold: number): boolean {
		const remainingLength = this.#buffer.length - this.#offset;
		if (remainingLength === 0 || remainingLength > maxHold) return false;
		for (const token of tokens) {
			if (token.length <= remainingLength) continue;
			if (this.#bufferIsPrefixOf(token, remainingLength)) return true;
		}
		return false;
	}

	#startsWithPartialXmlTag(): boolean {
		if (this.#buffer[this.#offset] !== "<") return false;
		const tailLength = this.#buffer.length - this.#offset;
		if (tailLength > MAX_XML_PARTIAL_HOLD) return false;
		for (let i = this.#offset + 1; i < this.#buffer.length; i++) {
			if (this.#buffer[i] === ">") return false;
		}
		return true;
	}

	#bufferIsPrefixOf(token: string, remainingLength: number): boolean {
		for (let i = 0; i < remainingLength; i++) {
			if (this.#buffer[this.#offset + i] !== token[i]) return false;
		}
		return true;
	}

	#finalizeKimiCall(): HealedToolCall {
		const rawId = this.#kimiPendingId.trim();
		const rawArgs = this.#kimiPendingArgs.trim();
		const name = normalizeFunctionName(rawId);

		let argsJson = rawArgs;
		if (rawArgs.length > 0) {
			try {
				argsJson = JSON.stringify(parseJsonWithRepair<unknown>(rawArgs));
			} catch {
				// Leave raw; downstream parseStreamingJson absorbs the failure.
			}
		} else {
			argsJson = "{}";
		}

		this.#kimiInCall = false;
		this.#kimiInArgs = false;
		this.#kimiPendingId = "";
		this.#kimiPendingArgs = "";
		return { id: generateHealedToolCallId(), name, arguments: argsJson };
	}

	#resetKimi(): void {
		this.#kimiInSection = false;
		this.#kimiInCall = false;
		this.#kimiInArgs = false;
		this.#kimiPendingId = "";
		this.#kimiPendingArgs = "";
	}
}

function parseDsmlEnvelope(envelope: string): readonly HealedToolCall[] {
	const healing = new StreamMarkupHealing({ pattern: "dsml" });
	healing.feed(envelope);
	return healing.drainCompleted();
}

function parseClaudeInternalEnvelope(envelope: string): readonly HealedToolCall[] {
	const inner = extractTagBody(envelope, TAG_CLAUDE_INTERNAL_OPEN, TAG_CLAUDE_INTERNAL_CLOSE);
	if (inner === undefined) return [];
	return parseInvokeCalls(inner);
}

function parseFunctionCallsEnvelope(envelope: string): readonly HealedToolCall[] {
	const inner = extractTagBody(envelope, TAG_FUNCTION_CALLS_OPEN, TAG_FUNCTION_CALLS_CLOSE);
	if (inner === undefined) return [];
	return parseInvokeCalls(inner);
}

function parseToolCallEnvelope(envelope: string): readonly HealedToolCall[] {
	const inner = extractTagBody(envelope, TAG_TOOL_CALL_OPEN, TAG_TOOL_CALL_CLOSE);
	if (inner === undefined) return [];

	const toolNameRaw = findFirstTagBody(inner, TAG_TOOL_NAME_OPEN, TAG_TOOL_NAME_CLOSE);
	if (toolNameRaw === undefined) return [];
	const toolName = normalizeFunctionName(decodeXmlEntities(toolNameRaw).trim());
	if (toolName.length === 0) return [];

	const parametersRaw = findFirstTagBody(inner, TAG_TOOL_PARAMETERS_OPEN, TAG_TOOL_PARAMETERS_CLOSE) ?? "";
	return [
		{
			id: generateHealedToolCallId(),
			name: toolName,
			arguments: parseToolParameters(parametersRaw),
		},
	];
}

function parseInvokeCalls(xml: string): HealedToolCall[] {
	const calls: HealedToolCall[] = [];
	let cursor = 0;
	while (cursor < xml.length) {
		const start = xml.indexOf("<invoke", cursor);
		if (start < 0) break;
		const boundary = xml[start + "<invoke".length];
		if (boundary !== undefined && !isXmlTagNameBoundary(boundary)) {
			cursor = start + 1;
			continue;
		}
		const openTagEnd = xml.indexOf(">", start + "<invoke".length);
		if (openTagEnd < 0) break;
		const closeIndex = xml.indexOf(TAG_INVOKE_CLOSE, openTagEnd + 1);
		if (closeIndex < 0) break;
		const envelope = xml.slice(start, closeIndex + TAG_INVOKE_CLOSE.length);
		const call = parseSingleInvoke(envelope);
		if (call) calls.push(call);
		cursor = closeIndex + TAG_INVOKE_CLOSE.length;
	}
	return calls;
}

function parseSingleInvoke(envelope: string): HealedToolCall | undefined {
	const openTagEnd = envelope.indexOf(">", "<invoke".length);
	if (openTagEnd < 0 || !envelope.endsWith(TAG_INVOKE_CLOSE)) return undefined;
	const openTag = envelope.slice(0, openTagEnd + 1);
	const rawName = extractAttribute(openTag, "name");
	if (rawName === undefined) return undefined;
	const toolName = normalizeFunctionName(decodeXmlEntities(rawName).trim());
	if (toolName.length === 0) return undefined;

	const body = envelope.slice(openTagEnd + 1, envelope.length - TAG_INVOKE_CLOSE.length);
	const args = parseParameterObject(body);
	return {
		id: generateHealedToolCallId(),
		name: toolName,
		arguments: JSON.stringify(args),
	};
}

function parseBareToolCall(toolName: string, body: string): HealedToolCall {
	return {
		id: generateHealedToolCallId(),
		name: normalizeFunctionName(toolName),
		arguments: JSON.stringify(parseBareParameterObject(body)),
	};
}

function parseBareParameterObject(xml: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	let cursor = 0;
	while (cursor < xml.length) {
		const openIndex = xml.indexOf("<", cursor);
		if (openIndex < 0) break;
		const nameStart = openIndex + 1;
		const firstNameChar = xml[nameStart];
		if (firstNameChar === undefined) break;
		if (firstNameChar === "/" || firstNameChar === "!" || firstNameChar === "?") {
			cursor = nameStart + 1;
			continue;
		}
		const nameEnd = findXmlTagNameEnd(xml, nameStart);
		if (nameEnd === nameStart) {
			cursor = nameStart;
			continue;
		}
		const boundary = xml[nameEnd];
		if (boundary === undefined) break;
		if (!isXmlTagNameBoundary(boundary)) {
			cursor = nameStart;
			continue;
		}
		const openTagEnd = xml.indexOf(">", nameEnd);
		if (openTagEnd < 0) break;
		const name = xml.slice(nameStart, nameEnd).trim();
		if (name.length === 0) {
			cursor = openTagEnd + 1;
			continue;
		}
		if (xml[openTagEnd - 1] === "/") {
			args[name] = "";
			cursor = openTagEnd + 1;
			continue;
		}
		const closeTag = `</${name}>`;
		const closeIndex = xml.indexOf(closeTag, openTagEnd + 1);
		if (closeIndex < 0) break;
		const value = decodeXmlEntities(xml.slice(openTagEnd + 1, closeIndex));
		args[name] = parseParameterValue(value);
		cursor = closeIndex + closeTag.length;
	}
	return args;
}

function normalizeAllowedToolNames(toolNames: ReadonlySet<string> | undefined): readonly string[] {
	if (toolNames === undefined || toolNames.size === 0) return [];
	const normalized = new Set<string>();
	for (const toolName of toolNames) {
		const name = normalizeFunctionName(toolName).trim();
		if (name.length === 0 || !isSafeBareToolTagName(name)) continue;
		normalized.add(name);
	}
	return [...normalized];
}

function minOpenIndex(current: number, candidate: number): number {
	if (candidate < 0) return current;
	return current < 0 || candidate < current ? candidate : current;
}

function findBareToolOpen(text: string, offset: number, toolName: string): number {
	const openTag = `<${toolName}`;
	let cursor = offset;
	while (cursor < text.length) {
		const candidate = text.indexOf(openTag, cursor);
		if (candidate < 0) return -1;
		const boundary = text[candidate + openTag.length];
		if (boundary === undefined || isXmlTagNameBoundary(boundary)) return candidate;
		cursor = candidate + 1;
	}
	return -1;
}

function findXmlTagNameEnd(xml: string, start: number): number {
	let cursor = start;
	while (cursor < xml.length) {
		const ch = xml[cursor]!;
		if (isXmlTagNameBoundary(ch)) break;
		cursor += 1;
	}
	return cursor;
}

function isSafeBareToolTagName(toolName: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(toolName);
}

function parseToolParameters(rawParameters: string): string {
	const trimmed = rawParameters.trim();
	if (trimmed.length === 0) return "{}";
	const decoded = decodeXmlEntities(trimmed);
	try {
		return JSON.stringify(parseJsonWithRepair<unknown>(decoded));
	} catch {
		return JSON.stringify(parseParameterObject(trimmed));
	}
}

function parseParameterObject(xml: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	let cursor = 0;
	while (cursor < xml.length) {
		const openIndex = xml.indexOf(TAG_PARAMETER_OPEN, cursor);
		if (openIndex < 0) break;
		const openTagEnd = xml.indexOf(">", openIndex + TAG_PARAMETER_OPEN.length);
		if (openTagEnd < 0) break;
		const closeIndex = xml.indexOf(TAG_PARAMETER_CLOSE, openTagEnd + 1);
		if (closeIndex < 0) break;
		const openTag = xml.slice(openIndex, openTagEnd + 1);
		const name = extractAttribute(openTag, "name");
		if (name !== undefined) {
			const normalizedName = decodeXmlEntities(name).trim();
			if (normalizedName.length > 0) {
				const valueRaw = xml.slice(openTagEnd + 1, closeIndex);
				const value = decodeXmlEntities(valueRaw);
				args[normalizedName] = parseParameterValue(value);
			}
		}
		cursor = closeIndex + TAG_PARAMETER_CLOSE.length;
	}
	return args;
}

function parseParameterValue(rawValue: string): unknown {
	try {
		return parseJsonWithRepair<unknown>(rawValue);
	} catch {
		return rawValue;
	}
}

function extractTagBody(xml: string, openTag: string, closeTag: string): string | undefined {
	if (!xml.startsWith(openTag) || !xml.endsWith(closeTag)) return undefined;
	return xml.slice(openTag.length, xml.length - closeTag.length);
}

function findFirstTagBody(xml: string, openTag: string, closeTag: string): string | undefined {
	const openIndex = xml.indexOf(openTag);
	if (openIndex < 0) return undefined;
	const valueStart = openIndex + openTag.length;
	const closeIndex = xml.indexOf(closeTag, valueStart);
	if (closeIndex < 0) return undefined;
	return xml.slice(valueStart, closeIndex);
}

function extractAttribute(openTag: string, attributeName: string): string | undefined {
	const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(openTag);
	if (!match) return undefined;
	return match[1] ?? match[2];
}

function decodeXmlEntities(text: string): string {
	return text.replace(/&quot;|&apos;|&lt;|&gt;|&amp;/g, token => {
		switch (token) {
			case "&quot;":
				return '"';
			case "&apos;":
				return "'";
			case "&lt;":
				return "<";
			case "&gt;":
				return ">";
			case "&amp;":
				return "&";
			default:
				return token;
		}
	});
}

function isXmlTagNameBoundary(ch: string): boolean {
	return ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function getTrailingPartialXmlOpenLength(text: string, bareToolNames: readonly string[] = []): number {
	if (text.length === 0) return 0;
	const maxPrefixLength = Math.min(
		MAX_XML_PARTIAL_HOLD,
		text.length,
		Math.max(
			...XML_HEAL_OPEN_PREFIXES.map(prefix => prefix.length),
			...bareToolNames.map(toolName => toolName.length + 1),
		),
	);
	for (let length = maxPrefixLength; length > 0; length--) {
		const suffix = text.slice(text.length - length);
		for (const prefix of XML_HEAL_OPEN_PREFIXES) {
			if (!prefix.startsWith(suffix)) continue;
			if (suffix.length < prefix.length) return suffix.length;
			if (prefix === "<invoke" && suffix === prefix) return suffix.length;
		}
		for (const toolName of bareToolNames) {
			const prefix = `<${toolName}`;
			if (!prefix.startsWith(suffix)) continue;
			if (suffix.length <= prefix.length) return suffix.length;
		}
	}
	return 0;
}

function shouldPreserveIncompleteEnvelopeTail(activeEnvelope: ActiveXmlEnvelope, fragment: string): boolean {
	if (activeEnvelope.kind === "bare_tool") return false;
	if (activeEnvelope.kind !== "invoke") return false;
	if (fragment.includes(TAG_PARAMETER_OPEN) || fragment.includes(TAG_INVOKE_CLOSE)) return false;
	return true;
}

function normalizeFunctionName(rawId: string): string {
	const stripped = rawId.startsWith("functions.") ? rawId.slice("functions.".length) : rawId;
	const colon = stripped.indexOf(":");
	return colon >= 0 ? stripped.slice(0, colon) : stripped;
}

function finalizeXmlToolCall(name: string, args: Record<string, unknown>): HealedToolCall {
	return {
		id: generateHealedToolCallId(),
		name: name.trim(),
		arguments: JSON.stringify(args),
	};
}

function coerceXmlParamValue(raw: string, isString: boolean): unknown {
	if (isString) return raw;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return raw;
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return raw;
	}
}

function generateHealedToolCallId(): string {
	return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Cheap model/provider gate for Kimi-K2 chat-template token leaks. */
export function modelMayLeakKimiToolCalls(provider: string, modelId: string): boolean {
	if (provider === "kimi-code" || provider === "moonshot") return true;
	return /kimi[-/_.]?k2/i.test(modelId);
}

/** Cheap model/provider gate for DeepSeek DSML envelope leaks. */
export function modelMayLeakDsmlToolCalls(provider: string, modelId: string): boolean {
	if (!/deepseek/i.test(modelId)) return false;
	return (
		provider === "ollama" ||
		provider === "ollama-cloud" ||
		provider === "nvidia" ||
		provider === "deepseek" ||
		provider === "fireworks" ||
		provider === "nanogpt" ||
		provider === "opencode-go" ||
		provider === "openrouter"
	);
}

export function modelMayLeakXmlToolCalls(provider: string, modelId: string): boolean {
	if (/deepseek-v4-(?:flash|pro)/i.test(modelId)) return true;
	if (provider === "cerebras" && isPrefixedModelFamily(modelId, "zai-glm")) return true;
	if (isPrefixedModelFamily(modelId, "z-ai/glm")) return true;
	if (isPrefixedModelFamily(modelId, "zai/glm")) return true;
	if (isPrefixedModelFamily(modelId, "zai.glm")) return true;
	return false;
}

function isPrefixedModelFamily(modelId: string, family: string): boolean {
	return modelId === family || modelId.startsWith(`${family}-`);
}

function shouldUseGenericXmlHealing(provider: string, modelId: string): boolean {
	if (!modelMayLeakXmlToolCalls(provider, modelId)) return false;
	if (/deepseek-v4-(?:flash|pro)/i.test(modelId)) {
		return provider !== "openai" && (provider === "opencode-go" || !modelMayLeakDsmlToolCalls(provider, modelId));
	}
	return true;
}

export function getStreamMarkupHealingPattern(
	provider: string,
	modelId: string,
	options?: { readonly parseThinkingTags?: boolean },
): StreamMarkupHealingPattern | undefined {
	if (options?.parseThinkingTags) return "thinking";
	if (modelMayLeakKimiToolCalls(provider, modelId)) return "kimi";
	if (shouldUseGenericXmlHealing(provider, modelId)) return "xml";
	if (modelMayLeakDsmlToolCalls(provider, modelId)) return "dsml";
	return undefined;
}
