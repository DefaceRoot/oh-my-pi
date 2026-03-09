import { beforeEach, describe, expect, test, vi } from "bun:test";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

async function createInteractiveMode(): Promise<InteractiveMode> {
	_resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();

	const session = {
		sessionManager: {
			getSessionName: () => undefined,
		},
		settings: Settings.isolated(),
		agent: {},
		skills: [],
		extensionRunner: undefined,
		customCommands: [],
	} as any;

	return new InteractiveMode(session, "test");
}

describe("InteractiveMode OAuth login wiring", () => {
	beforeEach(() => {
		_resetSettingsForTest();
	});

	test("routes manual callback URLs through the interactive mode manual input manager", async () => {
		const mode = await createInteractiveMode();
		const callbackUrl = "http://localhost/callback?code=abc&state=xyz";
		const pending = mode.oauthManualInput.waitForInput("anthropic");

		const handled = await executeBuiltinSlashCommand(`/login ${callbackUrl}`, {
			ctx: mode,
			handleBackgroundCommand: () => {},
		} as any);

		expect(handled).toBe(true);
		expect(await pending).toBe(callbackUrl);
		expect(mode.oauthManualInput.hasPending()).toBe(false);
	});

	test("forwards direct provider logins to the selector controller", async () => {
		const mode = Object.create(InteractiveMode.prototype) as any;
		const showOAuthSelector = vi.fn(async () => {});
		mode.selectorController = { showOAuthSelector };

		await mode.showOAuthSelector("login", "kagi");

		expect(showOAuthSelector).toHaveBeenCalledWith("login", "kagi");
	});
});
