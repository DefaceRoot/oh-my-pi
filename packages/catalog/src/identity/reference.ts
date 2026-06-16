/**
 * Proxy/reseller reference lookup: given a custom model id served through a
 * proxy (`[Kiro] claude-opus-4-8`, `gpt-5.4:cloud`, `vendor/claude-sonnet-4-6-thinking`),
 * find the bundled upstream model so missing pricing/capability metadata can be
 * inherited while keeping the custom transport.
 *
 * Kept separate from canonical-id resolution (`./equivalence`): this lookup
 * may strip `search`-style markers and prefers cache-pricing-complete
 * references, both of which would be wrong for canonical coalescing.
 */
import type { Api, Model } from "../types";
import { getBracketStrippedModelIdCandidates, getLongestModelLikeIdSegment, getModelLikeIdSegments } from "./id";
import { REFERENCE_TRAILING_MARKER_PATTERN } from "./markers";

export interface ModelReferenceIndex {
	exact: Map<string, Model<Api>>;
	suffixAlias: Map<string, Model<Api>>;
}

// xai-oauth subscription entries carry zero public pricing and inflated maxTokens;
// keep them provider-local so they cannot outrank paid/public Grok references.
export function isZeroCostXaiOAuthReference(candidate: Model<Api>): boolean {
	return (
		candidate.provider === "xai-oauth" &&
		candidate.cost.input === 0 &&
		candidate.cost.output === 0 &&
		candidate.cost.cacheRead === 0 &&
		candidate.cost.cacheWrite === 0
	);
}

/** A reference is useful for pricing/limits only when it carries real cost. */
export function referenceHasBillableCost(candidate: Model<Api>): boolean {
	const cost = candidate.cost;
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

// Prefer billable references over zero-cost shadows (resellers and subscription
// catalogs publish $0 entries with oversized limits that would otherwise win),
// then the reference with the largest limits and complete cache pricing, then
// first-party OpenAI entries.
function shouldReplaceReference(existing: Model<Api> | undefined, candidate: Model<Api>): boolean {
	if (!existing) return true;
	const existingBillable = referenceHasBillableCost(existing);
	const candidateBillable = referenceHasBillableCost(candidate);
	if (candidateBillable !== existingBillable) {
		return candidateBillable;
	}
	if (candidate.contextWindow !== existing.contextWindow) {
		return (candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0);
	}
	if (candidate.maxTokens !== existing.maxTokens) {
		return (candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0);
	}
	const existingHasCachePricing = existing.cost.cacheRead > 0 || existing.cost.cacheWrite > 0;
	const candidateHasCachePricing = candidate.cost.cacheRead > 0 || candidate.cost.cacheWrite > 0;
	if (candidateHasCachePricing !== existingHasCachePricing) {
		return candidateHasCachePricing;
	}
	return existing.provider !== "openai" && candidate.provider === "openai";
}

function normalizeReferenceKey(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Build a reference index from a model catalog (typically the bundled models).
 * Pure: callers are responsible for memoizing the result.
 */
export function buildModelReferenceIndex(models: Iterable<Model<Api>>): ModelReferenceIndex {
	const exact = new Map<string, Model<Api>>();
	for (const candidate of models) {
		if (isZeroCostXaiOAuthReference(candidate)) {
			continue;
		}
		const key = normalizeReferenceKey(candidate.id);
		if (shouldReplaceReference(exact.get(key), candidate)) {
			exact.set(key, candidate);
		}
	}
	return { exact, suffixAlias: buildSuffixAliasMap(exact) };
}

function buildSuffixAliasMap(exactReferences: ReadonlyMap<string, Model<Api>>): Map<string, Model<Api>> {
	const aliases = new Map<string, Model<Api>>();
	for (const reference of exactReferences.values()) {
		const slashIndex = reference.id.lastIndexOf("/");
		if (slashIndex === -1) {
			continue;
		}
		const suffix = reference.id.slice(slashIndex + 1);
		const alias = getLongestModelLikeIdSegment(suffix);
		if (!alias) {
			continue;
		}
		if (shouldReplaceReference(aliases.get(alias), reference)) {
			aliases.set(alias, reference);
		}
	}
	return aliases;
}

function stripReferenceTrailingMarker(candidate: string): string | undefined {
	const match = REFERENCE_TRAILING_MARKER_PATTERN.exec(candidate);
	return match ? candidate.slice(0, match.index) : undefined;
}

function getReferenceCandidateIds(modelId: string): string[] {
	const candidates = new Set<string>();
	const queue = [modelId];
	for (let index = 0; index < queue.length; index += 1) {
		const candidate = queue[index]?.trim();
		if (!candidate || candidates.has(candidate)) continue;
		candidates.add(candidate);

		for (const stripped of getBracketStrippedModelIdCandidates(candidate)) {
			queue.push(stripped);
		}
		for (const segment of getModelLikeIdSegments(candidate)) {
			queue.push(segment);
		}

		for (const suffix of [":cloud", "-cloud"] as const) {
			if (candidate.toLowerCase().endsWith(suffix)) {
				queue.push(candidate.slice(0, -suffix.length));
			}
		}

		const slashIndex = candidate.lastIndexOf("/");
		if (slashIndex !== -1) {
			queue.push(candidate.slice(slashIndex + 1));
		}

		const colonToDash = candidate.replace(/:/g, "-");
		if (colonToDash !== candidate) {
			queue.push(colonToDash);
		}

		const lowercased = candidate.toLowerCase();
		if (lowercased !== candidate) {
			queue.push(lowercased);
		}

		const strippedMarker = stripReferenceTrailingMarker(candidate);
		if (strippedMarker) {
			queue.push(strippedMarker);
		}
	}
	return [...candidates];
}

function lookupReference(index: ModelReferenceIndex, candidate: string): Model<Api> | undefined {
	const key = normalizeReferenceKey(candidate);
	return index.exact.get(key) ?? index.suffixAlias.get(key);
}

/** Resolve a (possibly proxied/affixed) model id to its bundled upstream reference. */
export function resolveModelReference(modelId: string, index: ModelReferenceIndex): Model<Api> | undefined {
	for (const candidate of getReferenceCandidateIds(modelId)) {
		const reference = lookupReference(index, candidate);
		if (reference) return reference;
	}
	return undefined;
}

// An id whose trailing marker is `free` (`:free`, `-free`) denotes an explicit
// free tier that prices at $0; pricing resolution must never substitute its
// paid base model.
const FREE_TIER_MARKER_PATTERN = /[-:]free$/i;

/**
 * Resolve to a *billable* upstream reference for pricing. Walks the same
 * candidate ids as {@link resolveModelReference} but skips zero-cost shadows
 * (e.g. `Codex/gpt-5.2-high` whose only exact match is a $0 Cursor alias) so a
 * later candidate (`gpt-5.2`) with real pricing wins. Falls back to the first
 * matched reference when none of the candidates carry cost. Explicit free-tier
 * ids resolve to no billable reference so they stay $0.
 */
export function resolveBillableModelReference(modelId: string, index: ModelReferenceIndex): Model<Api> | undefined {
	if (FREE_TIER_MARKER_PATTERN.test(modelId.trim())) {
		return undefined;
	}
	let firstMatch: Model<Api> | undefined;
	for (const candidate of getReferenceCandidateIds(modelId)) {
		const reference = lookupReference(index, candidate);
		if (!reference) continue;
		if (referenceHasBillableCost(reference)) return reference;
		firstMatch ??= reference;
	}
	return firstMatch;
}
