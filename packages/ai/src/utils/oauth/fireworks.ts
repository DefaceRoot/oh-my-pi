/**
 * Fireworks AI login flow.
 *
 * Fireworks AI provides OpenAI-compatible models via https://api.fireworks.ai/inference/v1.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to the Fireworks AI API key management page
 * 2. User copies their API key
 * 3. User pastes the API key into the CLI
 *
 * Fire Pass users: the same API key grants zero per-token access to
 * accounts/fireworks/routers/kimi-k2p5-turbo while a pass is active.
 */

import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController } from "./types";

const AUTH_URL = "https://app.fireworks.ai/api-keys";
const API_BASE_URL = "https://api.fireworks.ai/inference/v1";
// Use the Fire Pass router as the validation target — it is the primary model for this provider.
const VALIDATION_MODEL = "accounts/fireworks/routers/kimi-k2p5-turbo";

/**
 * Login to Fireworks AI.
 *
 * Opens browser to API keys page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this is not OAuth).
 */
export async function loginFireworks(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Fireworks AI login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the Fireworks AI dashboard",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Fireworks AI API key",
		placeholder: "fw_...",
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
		provider: "Fireworks AI",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return trimmed;
}
