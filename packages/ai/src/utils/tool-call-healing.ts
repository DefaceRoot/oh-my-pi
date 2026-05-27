/**
 * Streaming-safe filter for the Kimi K2 chat-template "tool-call section"
 * grammar.
 *
 * Some providers hosting Kimi K2 (the native `kimi-code` API, OpenRouter,
 * Fireworks, and others) leak the raw chat-template special tokens into
 * `delta.content` instead of emitting structured `tool_calls`. Visually
 * that looks like:
 *
 *     <|tool_calls_section_begin|>
 *       <|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":"foo"}<|tool_call_end|>
 *     <|tool_calls_section_end|>
 *
 * Without healing, the user sees the raw markers and the agent loop never
 * sees a tool call. This module reconstructs the embedded calls and strips
 * the markers from visible text. It is stream-aware: any partial token at
 * the end of a chunk is held back until the next chunk arrives.
 */

import { parseJsonWithRepair } from "./json-parse";

const TOK_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOK_SECTION_END = "<|tool_calls_section_end|>";
const TOK_CALL_BEGIN = "<|tool_call_begin|>";
const TOK_CALL_END = "<|tool_call_end|>";
const TOK_ARG_BEGIN = "<|tool_call_argument_begin|>";

const TOKENS = [TOK_SECTION_BEGIN, TOK_SECTION_END, TOK_CALL_BEGIN, TOK_CALL_END, TOK_ARG_BEGIN] as const;

/** Maximum buffered partial-token length before we give up holding back. */
const MAX_PARTIAL_HOLD = 64;

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
] as const;

type XmlEnvelopeKind = "claude_internal" | "function_calls" | "invoke" | "tool_call";

type ActiveXmlEnvelope = { readonly kind: XmlEnvelopeKind } | { readonly kind: "bare_tool"; readonly toolName: string };

export interface XmlToolCallHealerOptions {
	readonly toolNames?: ReadonlySet<string>;
}
type XmlEnvelopeStatus = "complete" | "incomplete" | "no_match";

interface XmlEnvelopeParse {
	readonly status: XmlEnvelopeStatus;
	readonly consumed: number;
	readonly calls: readonly HealedToolCall[];
	readonly dropOnFlush: boolean;
}

export interface HealedToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

/**
 * State machine that consumes streamed text, emits visible text with all
 * Kimi tool-call markers stripped, and accumulates the embedded tool calls
 * for the caller to drain after each `feed()`.
 *
 * One instance per stream. Feed only the channel that may carry leaked
 * markers (typically `delta.content`); mixing reasoning + content into the
 * same accumulator corrupts the holdback buffer if both channels race in
 * the same chunk.
 */
export class ToolCallHealer {
	#buffer = "";
	#offset = 0;
	#inSection = false;
	#inCall = false;
	#inArgs = false;
	#pendingId = "";
	#pendingArgs = "";
	#sectionTerminated = false;
	readonly #completed: HealedToolCall[] = [];

	/**
	 * Feed a chunk of streamed text. Returns the portion safe to emit
	 * downstream (with all tokens stripped). Any partial token suffix is
	 * held back until the next chunk arrives or {@link flushPending} is
	 * called.
	 */
	feed(text: string): string {
		if (text.length === 0) return "";
		this.#compact();
		this.#buffer += text;
		return this.#consume();
	}

	/**
	 * Like {@link feed}, but discards any tool calls that the chunk completes.
	 * Used when the upstream provider also emits structured `delta.tool_calls`
	 * for the same chunk: the healer still strips leaked marker text from the
	 * visible output, but the structured payload remains the single source of
	 * truth for the call list.
	 */
	consumeWithoutCalls(text: string): string {
		const clean = this.feed(text);
		if (this.#completed.length > 0) this.#completed.length = 0;
		return clean;
	}

	/**
	 * Drain accumulated tool calls. The internal list is cleared so a
	 * subsequent section in the same stream (rare) yields fresh calls.
	 */
	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush any held-back fragment when the stream ends. If we were mid-call
	 * the partial is dropped (emitting raw token bytes would surface markers
	 * to the user); otherwise the fragment is returned verbatim so a literal
	 * `<|` in prose is not silently lost.
	 */
	flushPending(): string {
		const tail = this.#remaining();
		this.#buffer = "";
		this.#offset = 0;
		if (this.#inCall || this.#inSection) return "";
		return tail;
	}

	/** True once any tool-call section in this stream has fully closed. */
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

	#consume(): string {
		let clean = "";

		while (this.#offset < this.#buffer.length) {
			if (this.#startsWithPartialToken()) break;

			if (this.#matches(TOK_SECTION_BEGIN)) {
				this.#inSection = true;
				this.#offset += TOK_SECTION_BEGIN.length;
				continue;
			}
			if (this.#matches(TOK_SECTION_END)) {
				this.#inSection = false;
				this.#sectionTerminated = true;
				this.#offset += TOK_SECTION_END.length;
				continue;
			}
			if (this.#matches(TOK_CALL_BEGIN)) {
				if (!this.#inSection) {
					// Literal mention outside a section — pass through as text so
					// docs/examples explaining tool tokens are not silently eaten.
					clean += TOK_CALL_BEGIN;
					this.#offset += TOK_CALL_BEGIN.length;
					continue;
				}
				this.#inCall = true;
				this.#inArgs = false;
				this.#pendingId = "";
				this.#pendingArgs = "";
				this.#offset += TOK_CALL_BEGIN.length;
				continue;
			}
			if (this.#matches(TOK_ARG_BEGIN)) {
				if (!this.#inSection) {
					clean += TOK_ARG_BEGIN;
					this.#offset += TOK_ARG_BEGIN.length;
					continue;
				}
				this.#inArgs = true;
				this.#offset += TOK_ARG_BEGIN.length;
				continue;
			}
			if (this.#matches(TOK_CALL_END)) {
				if (!this.#inSection || !this.#inCall) {
					// Token appeared outside an active call (e.g. an assistant
					// turn explaining the Kimi format). Emit it verbatim instead
					// of synthesizing a bogus empty tool call.
					clean += TOK_CALL_END;
					this.#offset += TOK_CALL_END.length;
					continue;
				}
				this.#finalizeCall();
				this.#offset += TOK_CALL_END.length;
				continue;
			}

			const ch = this.#buffer[this.#offset]!;
			this.#offset += 1;

			if (this.#inCall) {
				if (this.#inArgs) {
					this.#pendingArgs += ch;
				} else {
					this.#pendingId += ch;
				}
				continue;
			}

			// Inside the section but outside an individual call: swallow
			// inter-call whitespace/newlines. Outside the section: pass through.
			if (!this.#inSection) clean += ch;
		}

		return clean;
	}

	#matches(token: string): boolean {
		return this.#buffer.startsWith(token, this.#offset);
	}

	/**
	 * True if the remaining buffer is a strict prefix of any known token —
	 * we need more bytes before deciding whether it's a token or prose.
	 * Capped so a stray `<|` in normal text can't grow the holdback
	 * unboundedly.
	 */
	#startsWithPartialToken(): boolean {
		const remainingLength = this.#buffer.length - this.#offset;
		if (remainingLength === 0 || remainingLength > MAX_PARTIAL_HOLD) return false;
		for (const token of TOKENS) {
			if (token.length <= remainingLength) continue;
			if (this.#bufferIsPrefixOf(token, remainingLength)) return true;
		}
		return false;
	}

	#bufferIsPrefixOf(token: string, remainingLength: number): boolean {
		for (let i = 0; i < remainingLength; i++) {
			if (this.#buffer[this.#offset + i] !== token[i]) return false;
		}
		return true;
	}

	#finalizeCall(): void {
		const rawId = this.#pendingId.trim();
		const rawArgs = this.#pendingArgs.trim();
		const name = normalizeFunctionName(rawId);
		const id = generateHealedToolCallId();

		let argsJson = rawArgs;
		if (rawArgs.length > 0) {
			try {
				// Round-trip to normalize whitespace and repair near-valid JSON.
				argsJson = JSON.stringify(parseJsonWithRepair<unknown>(rawArgs));
			} catch {
				// Leave raw; downstream parseStreamingJson absorbs the failure.
			}
		} else {
			argsJson = "{}";
		}

		this.#completed.push({ id, name, arguments: argsJson });
		this.#inCall = false;
		this.#inArgs = false;
		this.#pendingId = "";
		this.#pendingArgs = "";
	}
}

export class XmlToolCallHealer {
	#buffer = "";
	#offset = 0;
	#activeEnvelope: ActiveXmlEnvelope | undefined;
	readonly #bareToolNames: readonly string[];
	readonly #completed: HealedToolCall[] = [];

	constructor(options: XmlToolCallHealerOptions = {}) {
		this.#bareToolNames = normalizeAllowedToolNames(options.toolNames);
	}

	feed(text: string): string {
		if (text.length === 0) return "";
		this.#compact();
		this.#buffer += text;
		return this.#consume();
	}

	consumeWithoutCalls(text: string): string {
		const clean = this.feed(text);
		if (this.#completed.length > 0) this.#completed.length = 0;
		return clean;
	}

	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	flushPending(): string {
		const tail = this.#remaining();
		if (this.#activeEnvelope === undefined) {
			this.#buffer = "";
			this.#offset = 0;
			return tail;
		}
		const shouldPreserveActiveTail = shouldPreserveIncompleteEnvelopeTail(this.#activeEnvelope, tail);
		this.#buffer = "";
		this.#offset = 0;
		this.#activeEnvelope = undefined;
		return shouldPreserveActiveTail ? tail : "";
	}

	#remaining(): string {
		return this.#offset === 0 ? this.#buffer : this.#buffer.slice(this.#offset);
	}

	#compact(): void {
		if (this.#offset === 0) return;
		this.#buffer = this.#buffer.slice(this.#offset);
		this.#offset = 0;
	}

	#consume(): string {
		let clean = "";
		while (this.#offset < this.#buffer.length) {
			if (!this.#activeEnvelope) {
				const openIndex = this.#findNextOpen();
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

				const beginStatus = this.#beginEnvelope();
				if (beginStatus === "incomplete") break;
				if (beginStatus === "no_match") {
					clean += this.#buffer[this.#offset]!;
					this.#offset += 1;
				}
				continue;
			}

			const parsed = this.#parseActiveEnvelope();
			if (parsed.status === "incomplete") break;
			if (parsed.status === "no_match") {
				this.#activeEnvelope = undefined;
				clean += this.#buffer[this.#offset]!;
				this.#offset += 1;
				continue;
			}
			for (const call of parsed.calls) this.#completed.push(call);
			this.#offset += parsed.consumed;
			this.#activeEnvelope = undefined;
		}
		return clean;
	}

	#findNextOpen(): number {
		const candidates = [
			this.#buffer.indexOf(TAG_CLAUDE_INTERNAL_OPEN, this.#offset),
			this.#buffer.indexOf(TAG_FUNCTION_CALLS_OPEN, this.#offset),
			this.#buffer.indexOf(TAG_TOOL_CALL_OPEN, this.#offset),
			this.#buffer.indexOf("<invoke", this.#offset),
		];
		let min = -1;
		for (const candidate of candidates) min = minOpenIndex(min, candidate);
		for (const toolName of this.#bareToolNames) {
			min = minOpenIndex(min, findBareToolOpen(this.#buffer, this.#offset, toolName));
		}
		return min;
	}

	#beginEnvelope(): XmlEnvelopeStatus {
		if (this.#buffer.startsWith(TAG_CLAUDE_INTERNAL_OPEN, this.#offset)) {
			this.#activeEnvelope = { kind: "claude_internal" };
			return "complete";
		}
		if (this.#buffer.startsWith(TAG_FUNCTION_CALLS_OPEN, this.#offset)) {
			this.#activeEnvelope = { kind: "function_calls" };
			return "complete";
		}
		if (this.#buffer.startsWith(TAG_TOOL_CALL_OPEN, this.#offset)) {
			this.#activeEnvelope = { kind: "tool_call" };
			return "complete";
		}
		if (this.#buffer.startsWith("<invoke", this.#offset)) {
			const boundaryIndex = this.#offset + "<invoke".length;
			const boundary = this.#buffer[boundaryIndex];
			if (boundary === undefined) return "incomplete";
			if (!isXmlTagNameBoundary(boundary)) return "no_match";
			this.#activeEnvelope = { kind: "invoke" };
			return "complete";
		}
		for (const toolName of this.#bareToolNames) {
			const openTag = `<${toolName}`;
			if (!this.#buffer.startsWith(openTag, this.#offset)) continue;
			const boundary = this.#buffer[this.#offset + openTag.length];
			if (boundary === undefined) return "incomplete";
			if (!isXmlTagNameBoundary(boundary)) return "no_match";
			this.#activeEnvelope = { kind: "bare_tool", toolName };
			return "complete";
		}
		return "no_match";
	}

	#parseActiveEnvelope(): XmlEnvelopeParse {
		if (!this.#activeEnvelope) return { status: "no_match", consumed: 0, calls: [], dropOnFlush: false };
		switch (this.#activeEnvelope.kind) {
			case "claude_internal":
				return this.#parseStaticEnvelope(
					TAG_CLAUDE_INTERNAL_OPEN,
					TAG_CLAUDE_INTERNAL_CLOSE,
					parseClaudeInternalEnvelope,
				);
			case "function_calls":
				return this.#parseStaticEnvelope(
					TAG_FUNCTION_CALLS_OPEN,
					TAG_FUNCTION_CALLS_CLOSE,
					parseFunctionCallsEnvelope,
				);
			case "tool_call":
				return this.#parseStaticEnvelope(TAG_TOOL_CALL_OPEN, TAG_TOOL_CALL_CLOSE, parseToolCallEnvelope);
			case "invoke":
				return this.#parseInvokeEnvelope();
			case "bare_tool":
				return this.#parseBareToolEnvelope(this.#activeEnvelope.toolName);
		}
	}

	#parseStaticEnvelope(
		openTag: string,
		closeTag: string,
		parse: (envelope: string) => readonly HealedToolCall[],
	): XmlEnvelopeParse {
		if (!this.#buffer.startsWith(openTag, this.#offset)) {
			return { status: "no_match", consumed: 0, calls: [], dropOnFlush: false };
		}
		const closeIndex = this.#buffer.indexOf(closeTag, this.#offset + openTag.length);
		if (closeIndex < 0) return { status: "incomplete", consumed: 0, calls: [], dropOnFlush: true };
		const consumed = closeIndex + closeTag.length - this.#offset;
		const envelope = this.#buffer.slice(this.#offset, this.#offset + consumed);
		return {
			status: "complete",
			consumed,
			calls: parse(envelope),
			dropOnFlush: true,
		};
	}

	#parseInvokeEnvelope(): XmlEnvelopeParse {
		if (!this.#buffer.startsWith("<invoke", this.#offset)) {
			return { status: "no_match", consumed: 0, calls: [], dropOnFlush: false };
		}
		const openTagEnd = this.#buffer.indexOf(">", this.#offset + "<invoke".length);
		if (openTagEnd < 0) return { status: "incomplete", consumed: 0, calls: [], dropOnFlush: true };
		const closeIndex = this.#buffer.indexOf(TAG_INVOKE_CLOSE, openTagEnd + 1);
		if (closeIndex < 0) return { status: "incomplete", consumed: 0, calls: [], dropOnFlush: true };
		const consumed = closeIndex + TAG_INVOKE_CLOSE.length - this.#offset;
		const envelope = this.#buffer.slice(this.#offset, this.#offset + consumed);
		const call = parseSingleInvoke(envelope);
		return {
			status: "complete",
			consumed,
			calls: call ? [call] : [],
			dropOnFlush: true,
		};
	}

	#parseBareToolEnvelope(toolName: string): XmlEnvelopeParse {
		const openTag = `<${toolName}`;
		if (!this.#buffer.startsWith(openTag, this.#offset)) {
			return { status: "no_match", consumed: 0, calls: [], dropOnFlush: false };
		}
		const boundary = this.#buffer[this.#offset + openTag.length];
		if (boundary === undefined) return { status: "incomplete", consumed: 0, calls: [], dropOnFlush: true };
		if (!isXmlTagNameBoundary(boundary)) return { status: "no_match", consumed: 0, calls: [], dropOnFlush: false };
		const openTagEnd = this.#buffer.indexOf(">", this.#offset + openTag.length);
		if (openTagEnd < 0) return { status: "incomplete", consumed: 0, calls: [], dropOnFlush: true };
		const closeTag = `</${toolName}>`;
		const closeIndex = this.#buffer.indexOf(closeTag, openTagEnd + 1);
		if (closeIndex < 0) return { status: "incomplete", consumed: 0, calls: [], dropOnFlush: true };
		const consumed = closeIndex + closeTag.length - this.#offset;
		const body = this.#buffer.slice(openTagEnd + 1, closeIndex);
		return {
			status: "complete",
			consumed,
			calls: [parseBareToolCall(toolName, body)],
			dropOnFlush: true,
		};
	}
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
		if (boundary !== undefined && !isInvokeTagBoundary(boundary)) {
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

function isInvokeTagBoundary(ch: string): boolean {
	return isXmlTagNameBoundary(ch);
}

function isXmlTagNameBoundary(ch: string): boolean {
	return ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function getTrailingPartialXmlOpenLength(text: string, bareToolNames: readonly string[] = []): number {
	if (text.length === 0) return 0;
	const maxPrefixLength = Math.min(
		MAX_PARTIAL_HOLD,
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
/**
 * Cheap test for whether a given model is known to leak Kimi-K2 chat-template
 * tool-call tokens into visible text. Used to gate the per-stream healer so
 * non-Kimi providers do not pay for the scan.
 */
export function modelMayLeakKimiToolCalls(provider: string, modelId: string): boolean {
	if (provider === "kimi-code" || provider === "moonshot") return true;
	return /kimi[-/_.]?k2/i.test(modelId);
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
function normalizeFunctionName(rawId: string): string {
	const stripped = rawId.startsWith("functions.") ? rawId.slice("functions.".length) : rawId;
	const colon = stripped.indexOf(":");
	return colon >= 0 ? stripped.slice(0, colon) : stripped;
}

function generateHealedToolCallId(): string {
	return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
