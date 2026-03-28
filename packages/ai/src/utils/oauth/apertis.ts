/**
 * Apertis.ai login flow.
 *
 * Apertis.ai provides 470+ AI models via an OpenAI-compatible API at https://api.apertis.ai/v1.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to the Apertis.ai API key management page
 * 2. User copies their API key (format: sk-... or sk-sub-...)
 * 3. User pastes the API key into the CLI
 */

import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController } from "./types";

const AUTH_URL = "https://apertis.ai/token";
const API_BASE_URL = "https://api.apertis.ai/v1";
const VALIDATION_MODEL = "deepseek-v3.2";

/**
 * Login to Apertis.ai.
 *
 * Opens browser to the API key management page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginApertis(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Apertis.ai login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the Apertis.ai dashboard",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Apertis.ai API key",
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	options.onProgress?.("Validating API key...");
	await validateOpenAICompatibleApiKey({
		provider: "Apertis.ai",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return trimmed;
}
