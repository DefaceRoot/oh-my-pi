import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

type RuntimeHarness = {
	runtime: { ctx: InteractiveModeContext; handleBackgroundCommand: () => void };
	getStatus: () => string | undefined;
	getInvalidationCount: () => number;
};

const createRuntimeHarness = (options?: {
	provider?: string;
	modelId?: string;
	serviceTier?: "priority" | undefined;
}): RuntimeHarness => {
	let statusMessage: string | undefined;
	let invalidationCount = 0;
	const session = {
		model: {
			provider: options?.provider ?? "anthropic",
			id: options?.modelId ?? "claude-opus-4-6",
		},
		get serviceTier() {
			return options?.serviceTier;
		},
		isFastModeEnabled() {
			return options?.serviceTier === "priority";
		},
		setFastMode(enabled: boolean) {
			const blocked = enabled && options?.provider === "openai-codex";
			options = { ...options, serviceTier: blocked ? undefined : enabled ? "priority" : undefined };
			return options.serviceTier === "priority";
		},
		toggleFastMode() {
			const nextEnabled = options?.serviceTier !== "priority";
			return this.setFastMode(nextEnabled);
		},
	} as InteractiveModeContext["session"];

	const ctx = {
		session,
		statusLine: {
			invalidate: () => {
				invalidationCount += 1;
			},
		} as InteractiveModeContext["statusLine"],
		updateEditorTopBorder: () => {},
		ui: {
			requestRender: () => {},
		} as InteractiveModeContext["ui"],
		editor: {
			setText: () => {},
		} as unknown as InteractiveModeContext["editor"],
		showStatus: (message: string) => {
			statusMessage = message;
		},
	} as InteractiveModeContext;

	return {
		runtime: {
			ctx,
			handleBackgroundCommand: () => {},
		},
		getStatus: () => statusMessage,
		getInvalidationCount: () => invalidationCount,
	};
};

describe("/fast slash command", () => {
	it("blocks enabling fast mode for openai-codex", async () => {
		const harness = createRuntimeHarness({ provider: "openai-codex", modelId: "gpt-5.4" });

		const handled = await executeBuiltinSlashCommand("/fast on", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getStatus()).toBe(
			"Fast mode is unavailable for openai-codex/gpt-5.4; priority service tier stays off.",
		);
		expect(harness.getInvalidationCount()).toBe(0);
	});

	it("reports blocked fast mode status for openai-codex", async () => {
		const harness = createRuntimeHarness({ provider: "openai-codex", modelId: "gpt-5.4" });

		const handled = await executeBuiltinSlashCommand("/fast status", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getStatus()).toBe(
			"Fast mode is off for openai-codex/gpt-5.4. OpenAI Codex blocks priority service tier.",
		);
	});
});
