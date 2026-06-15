/**
 * Streaming-safe filters for leaked chat-template tool-call and thinking markup.
 *
 * Hosted models sometimes leak raw template markup into visible `content` instead
 * of returning structured events. Tool-call healing delegates the common dialects
 * to the owned in-band scanners and keeps the provider-facing compatibility
 * wrapper, model/provider gating, and generic XML fallback for legacy leaks.
 */

import { isDeepseekModelIdOrName } from "@oh-my-pi/pi-catalog/identity";

import { createInbandScanner } from "../dialect/factory";
import { ThinkingInbandScanner } from "../dialect/thinking";
import type { InbandScanEvent, InbandScanner } from "../dialect/types";
import { parseJsonWithRepair } from "./json-parse";

const KIMI_SECTION_END = "<|tool_calls_section_end|>";
const DSML_TOOL_CALLS_CLOSE_FULLWIDTH = "</｜DSML｜tool_calls>";
const DSML_TOOL_CALLS_CLOSE_ASCII = "</|DSML|tool_calls>";
const KIMI_SECTION_CLOSE_TOKENS = [KIMI_SECTION_END] as const;
const DSML_TOOL_CALLS_CLOSE_TOKENS = [DSML_TOOL_CALLS_CLOSE_FULLWIDTH, DSML_TOOL_CALLS_CLOSE_ASCII] as const;

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

/** Cap held-back XML tag bytes so a stray `<` in prose cannot grow unboundedly. */
const MAX_XML_PARTIAL_HOLD = 256;

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

type XmlEnvelopeKind = "claude_internal" | "function_calls" | "invoke" | "tool_call" | "dsml_fullwidth" | "dsml_ascii";

type ActiveXmlEnvelope = { readonly kind: XmlEnvelopeKind } | { readonly kind: "bare_tool"; readonly toolName: string };

type XmlEnvelopeStatus = "complete" | "incomplete" | "no_match";

interface XmlEnvelopeParse {
	readonly status: XmlEnvelopeStatus;
	readonly consumed: number;
	readonly calls: readonly HealedToolCall[];
}

/**
 * State machine that consumes streamed visible text and emits cleaned text,
 * thinking deltas, and reconstructed tool calls.
 *
 * Feed only one stream channel (usually `delta.content` / `message.content`).
 * Mixing reasoning and visible text into the same instance can corrupt held-back
 * partial tag buffers.
 */
export class StreamMarkupHealing {
	readonly #pattern: StreamMarkupHealingPattern;
	readonly #scanner: InbandScanner | undefined;
	#sectionTerminated = false;
	readonly #completed: HealedToolCall[] = [];
	readonly #bareToolNames: readonly string[];
	#sectionCloseTail = "";

	#buffer = "";
	#offset = 0;
	#activeXmlEnvelope: ActiveXmlEnvelope | undefined;

	constructor(options: StreamMarkupHealingOptions) {
		this.#pattern = options.pattern;
		this.#bareToolNames = normalizeAllowedToolNames(options.toolNames);
		this.#scanner =
			options.pattern === "xml"
				? undefined
				: options.pattern === "kimi"
					? createInbandScanner("kimi")
					: options.pattern === "dsml"
						? createInbandScanner("xml", { xmlTagset: "dsml" })
						: new ThinkingInbandScanner();
	}

	get pattern(): StreamMarkupHealingPattern {
		return this.#pattern;
	}

	/**
	 * Feed a chunk and return visible text only. Reconstructed tool calls are
	 * stored for {@link drainCompleted}; thinking blocks are intentionally not
	 * returned by this compatibility helper. Use {@link feedEvents} when the caller
	 * needs ordered text/thinking/tool-call events.
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
		if (this.#pattern === "xml") {
			this.#compact();
			this.#buffer += text;
			return this.#consumeGenericXmlEvents();
		}
		this.#markSectionClosed(text);
		return this.#convertScannerEvents(this.#scanner!.feed(text));
	}

	/**
	 * Feed a chunk and return cleaned events, excluding synthesized tool calls.
	 * Used when the upstream chunk also carries structured `tool_calls`, keeping
	 * that structured payload as the single source of truth while preserving
	 * adjacent text and thinking events.
	 */
	feedEventsWithoutCalls(text: string): StreamMarkupHealingEvent[] {
		const events = this.feedEvents(text);
		let out: StreamMarkupHealingEvent[] | undefined;
		for (let i = 0; i < events.length; i++) {
			const event = events[i]!;
			if (event.type === "toolCall") {
				out ??= events.slice(0, i);
			} else if (out) {
				out.push(event);
			}
		}
		return out ?? events;
	}

	/** Drain accumulated tool calls from calls to {@link feed}. */
	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush held-back stream-end fragments as ordered events. Partial tool-call
	 * sections/envelopes are dropped by the delegated scanners; unterminated
	 * thinking blocks are emitted as thinking, matching the previous MiniMax parser
	 * behavior.
	 */
	flushEvents(): StreamMarkupHealingEvent[] {
		if (this.#pattern !== "xml") return this.#convertScannerEvents(this.#scanner!.flush());

		const tail = this.#remaining();
		this.#buffer = "";
		this.#offset = 0;
		const activeEnvelope = this.#activeXmlEnvelope;
		this.#activeXmlEnvelope = undefined;
		if (tail.length === 0) return [];
		if (!activeEnvelope || shouldPreserveIncompleteEnvelopeTail(activeEnvelope, tail)) {
			return [{ type: "text", text: tail }];
		}
		return [];
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

	#markSectionClosed(text: string): void {
		if (this.#sectionTerminated) return;
		const closeTokens =
			this.#pattern === "kimi"
				? KIMI_SECTION_CLOSE_TOKENS
				: this.#pattern === "dsml"
					? DSML_TOOL_CALLS_CLOSE_TOKENS
					: undefined;
		if (closeTokens === undefined) return;

		const scanText = this.#sectionCloseTail.length === 0 ? text : this.#sectionCloseTail + text;
		for (const token of closeTokens) {
			if (!scanText.includes(token)) continue;
			this.#sectionTerminated = true;
			this.#sectionCloseTail = "";
			return;
		}
		this.#sectionCloseTail = trailingTokenPrefix(scanText, closeTokens);
	}

	#convertScannerEvents(events: readonly InbandScanEvent[]): StreamMarkupHealingEvent[] {
		const out: StreamMarkupHealingEvent[] = [];
		for (const event of events) {
			switch (event.type) {
				case "text":
					out.push({ type: "text", text: event.text });
					break;
				case "thinkingDelta":
					if (event.delta.length > 0) out.push({ type: "thinking", thinking: event.delta });
					break;
				case "toolEnd":
					out.push({
						type: "toolCall",
						call: {
							id: generateHealedToolCallId(),
							name: event.name,
							arguments: JSON.stringify(event.arguments),
						},
					});
					break;
				case "thinkingStart":
				case "thinkingEnd":
				case "toolStart":
				case "toolArgDelta":
					break;
			}
		}
		return out;
	}

	#remaining(): string {
		return this.#offset === 0 ? this.#buffer : this.#buffer.slice(this.#offset);
	}

	#compact(): void {
		if (this.#offset === 0) return;
		this.#buffer = this.#buffer.slice(this.#offset);
		this.#offset = 0;
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
}

function trailingTokenPrefix(text: string, tokens: readonly string[]): string {
	let maxLength = 0;
	for (const token of tokens) {
		const candidate = token.length - 1;
		if (candidate > maxLength) maxLength = candidate;
	}
	maxLength = Math.min(maxLength, text.length);
	for (let length = maxLength; length > 0; length--) {
		const suffix = text.slice(text.length - length);
		for (const token of tokens) {
			if (token.startsWith(suffix)) return suffix;
		}
	}
	return "";
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
	if (!isDeepseekModelIdOrName(modelId)) return false;
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

/** Cheap model/provider gate for MiniMax plain thinking tag leaks. */
export function modelMayLeakThinkingTags(provider: string, modelId: string): boolean {
	return /minimax/i.test(provider) || /minimax/i.test(modelId);
}

export function getStreamMarkupHealingPattern(
	provider: string,
	modelId: string,
	options?: { readonly parseThinkingTags?: boolean },
): StreamMarkupHealingPattern | undefined {
	if (options?.parseThinkingTags || modelMayLeakThinkingTags(provider, modelId)) return "thinking";
	if (modelMayLeakKimiToolCalls(provider, modelId)) return "kimi";
	if (shouldUseGenericXmlHealing(provider, modelId)) return "xml";
	if (modelMayLeakDsmlToolCalls(provider, modelId)) return "dsml";
	return undefined;
}
