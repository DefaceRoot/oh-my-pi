import type { Api, KnownApi } from '../types';

export interface TemperatureBounds {
	/** Lowest valid temperature. Always 0 for providers that support sampling. */
	min: number;
	/** Highest valid temperature the provider accepts. */
	max: number;
}

/**
 * Result of a temperature bounds lookup.
 *
 * When `applicable` is true, `min` and `max` carry the valid numeric range and
 * callers should validate the user's input against them.
 *
 * When `applicable` is false, temperature is either not a meaningful parameter
 * for the API (e.g. reasoning-only) or the API's bounds are not known (e.g. a
 * third-party extension). In both cases callers should skip numeric bounds
 * validation; only the sentinel -1 ('use provider default') is valid.
 */
export type TemperatureBoundsResult =
	| ({ readonly applicable: true } & TemperatureBounds)
	| { readonly applicable: false };

/**
 * Per-API-type temperature bounds, exhaustive over all KnownApi members.
 *
 * The sentinel -1 ('provider default') is always valid and is handled by
 * callers before consulting this table.
 *
 * Sources:
 *   Anthropic      — https://docs.anthropic.com/en/api/messages              (0–1)
 *   OpenAI         — https://platform.openai.com/docs/api-reference/chat     (0–2)
 *   Google         — https://ai.google.dev/gemini-api/docs/models            (0–2)
 *   Amazon Bedrock — https://docs.aws.amazon.com/bedrock/latest/userguide/inference-parameters.html (0–1)
 *   OpenAI-compatible providers follow the OpenAI spec (0–2).
 */
const TEMPERATURE_BOUNDS_BY_KNOWN_API = {
	'anthropic-messages': { min: 0, max: 1 },
	'openai-responses': { min: 0, max: 2 },
	'openai-completions': { min: 0, max: 2 },
	'azure-openai-responses': { min: 0, max: 2 },
	'bedrock-converse-stream': { min: 0, max: 1 },
	'google-generative-ai': { min: 0, max: 2 },
	'google-gemini-cli': { min: 0, max: 2 },
	'google-vertex': { min: 0, max: 2 },
	'cursor-agent': { min: 0, max: 2 },
	// Reasoning-only API — temperature is not a meaningful parameter.
	// This entry exists solely to keep the satisfies check exhaustive over KnownApi.
	'openai-codex-responses': { min: 0, max: 0 },
} satisfies Record<KnownApi, TemperatureBounds>;

/**
 * Return the temperature bounds for the given API type.
 *
 * When `applicable` is false the caller should skip numeric bounds validation;
 * only the sentinel -1 ('use provider default') is valid. This covers:
 *   - `openai-codex-responses`: reasoning-only API, temperature is not supported.
 *   - Unknown/extension APIs: no authoritative bounds available.
 *
 * The sentinel -1 itself is not covered by these bounds — callers must check
 * for -1 before calling this function.
 */
export function getTemperatureBounds(api: Api | string): TemperatureBoundsResult {
	// Reasoning-only API — temperature is not a meaningful parameter.
	if (api === 'openai-codex-responses') return { applicable: false };

	if (Object.hasOwn(TEMPERATURE_BOUNDS_BY_KNOWN_API, api)) {
		return { applicable: true, ...TEMPERATURE_BOUNDS_BY_KNOWN_API[api as KnownApi] };
	}

	// Unknown/extension API: no authoritative bounds; callers skip validation.
	return { applicable: false };
}
