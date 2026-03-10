import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as readlinePromises from "node:readline/promises";
import { type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { readImageFromClipboard } from "@oh-my-pi/pi-natives";
import { $env, getProjectDir } from "@oh-my-pi/pi-utils";
import type { SettingPath, SettingValue } from "../../config/settings";
import { settings } from "../../config/settings";
import { theme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import type { AgentSessionEvent } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../../session/messages";
import { STTController, type SttState } from "../../stt";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { resizeImage } from "../../utils/image-resize";
import { generateSessionTitle, setTerminalTitle } from "../../utils/title-generator";

import { WORKFLOW_MENUS } from "../action-buttons";

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

export function detectLazygitInstallCommand(): { command: string; args: string[] } | null {
	if (process.platform === "win32") return null;
	const isRoot = process.getuid && process.getuid() === 0;

	if (Bun.which("brew")) return { command: "brew", args: ["install", "lazygit"] };

	const hasSudo = !isRoot && !!Bun.which("sudo");
	if (!isRoot && !hasSudo) return null;

	const managers = [
		{ name: "apt", args: ["install", "-y", "lazygit"] },
		{ name: "dnf", args: ["install", "-y", "lazygit"] },
		{ name: "pacman", args: ["-S", "--noconfirm", "lazygit"] },
		{ name: "apk", args: ["add", "lazygit"] },
	] as const;

	for (const manager of managers) {
		if (Bun.which(manager.name)) {
			if (isRoot) return { command: manager.name, args: manager.args as unknown as string[] };
			return { command: "sudo", args: [manager.name, ...manager.args] as string[] };
		}
	}
	return null;
}

const CTRL_X_BYTE = "\x18";
const CTRL_N_BYTE = "\x0e";
const CTRL_P_BYTE = "\x10";
const CTRL_O_BYTE = "\x0f";
const CTRL_R_BYTE = "\x12";
const CTRL_V_BYTE = "\x16";
const ESC_BYTE = "\x1b";
const CTRLX_CHORD_TIMEOUT_MS = 350;

export class InputController {
	#askModePreviousRole: "default" | "ask" | "orchestrator" | "plan" | "custom" | undefined;
	#askModePreviousModel: Model | undefined;
	#sttController = new STTController();
	#chordArmed = false;
	#chordTimer: ReturnType<typeof setTimeout> | undefined;
	#unsubscribeChord: (() => void) | undefined;

	constructor(private ctx: InteractiveModeContext) {}

	setupKeyHandlers(): void {
		this.ctx.editor.onEscape = () => {
			if (this.ctx.statusLine.getActiveMenu()) {
				this.ctx.statusLine.closeMenu();
				this.ctx.ui.requestRender();
				return;
			}
			if (this.ctx.isSubagentViewActive()) {
				this.ctx.exitSubagentView();
				return;
			}
			if (this.ctx.loadingAnimation) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.ctx.session.isBashRunning) {
				this.ctx.session.abortBash();
			} else if (this.ctx.isBashMode) {
				this.ctx.editor.setText("");
				this.ctx.isBashMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isPythonRunning) {
				this.ctx.session.abortPython();
			} else if (this.ctx.isPythonMode) {
				this.ctx.editor.setText("");
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.#isAskModeActive()) {
				void this.#restoreAskMode();
			} else if (!this.ctx.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /branch, or nothing based on setting
				const action = settings.get("doubleEscapeAction");
				if (action !== "none") {
					const now = Date.now();
					if (now - this.ctx.lastEscapeTime < 500) {
						if (action === "tree") {
							this.ctx.showTreeSelector();
						} else {
							this.ctx.showUserMessageSelector();
						}
						this.ctx.lastEscapeTime = 0;
					} else {
						this.ctx.lastEscapeTime = now;
					}
				}
			}
		};

		this.ctx.editor.onCtrlC = () => this.handleCtrlC();
		this.ctx.editor.onCtrlD = () => this.handleCtrlD();
		this.ctx.editor.onCtrlZ = () => this.handleCtrlZ();
		this.ctx.editor.onShiftTab = () => {
			this.cycleThinkingLevel();
		};
		this.ctx.editor.onCtrlP = () => this.cycleRoleModel();
		this.ctx.editor.onShiftCtrlP = () => this.cycleRoleModel({ temporary: true });
		this.ctx.editor.onAltP = () => this.ctx.showModelSelector({ temporaryOnly: true });

		// Global debug handler on TUI (works regardless of focus)
		this.ctx.ui.onDebug = () => this.ctx.showDebugSelector();
		this.ctx.editor.onCtrlL = () => this.ctx.showModelSelector();
		this.ctx.editor.onCtrlR = () => this.ctx.showHistorySearch();
		this.ctx.editor.onCtrlT = () => this.ctx.toggleTodoExpansion();
		for (const key of this.ctx.keybindings.getKeys("lazygit")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.openLazygit());
		}
		for (const key of this.ctx.keybindings.getKeys("externalEditor")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.openExternalEditor());
		}
		this.ctx.editor.onQuestionMark = () => this.ctx.handleHotkeysCommand();
		this.ctx.editor.onCtrlV = () => this.handleImagePaste();

		// Wire up extension shortcuts
		this.registerExtensionShortcuts();

		const expandToolsKeys = this.ctx.keybindings.getKeys("expandTools");
		this.ctx.editor.onCtrlO = expandToolsKeys.includes("ctrl+o") ? () => this.toggleToolOutputExpansion() : undefined;
		for (const key of expandToolsKeys) {
			if (key === "ctrl+o") continue;
			this.ctx.editor.setCustomKeyHandler(key, () => this.toggleToolOutputExpansion());
		}

		const dequeueKeys = this.ctx.keybindings.getKeys("dequeue");
		this.ctx.editor.onAltUp = dequeueKeys.includes("alt+up") ? () => this.handleDequeue() : undefined;
		for (const key of dequeueKeys) {
			if (key === "alt+up") continue;
			this.ctx.editor.setCustomKeyHandler(key, () => this.handleDequeue());
		}

		const planModeKeys = this.ctx.keybindings.getKeys("togglePlanMode");
		for (const key of planModeKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handlePlanModeCommand());
		}
		for (const key of this.ctx.keybindings.getKeys("toggleAskMode")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.#toggleAskMode());
		}

		for (const key of this.ctx.keybindings.getKeys("toggleSTT")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.toggleSTT());
		}

		for (const key of this.ctx.keybindings.getKeys("newSession")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				void this.ctx.handleClearCommand();
			});
		}
		for (const key of this.ctx.keybindings.getKeys("tree")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.ctx.showTreeSelector();
			});
		}
		for (const key of this.ctx.keybindings.getKeys("fork")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				this.ctx.showUserMessageSelector();
			});
		}
		for (const menu of WORKFLOW_MENUS) {
			for (const key of this.ctx.keybindings.getKeys(
				menu.hotkeyAction as import("../../config/keybindings").AppAction,
			)) {
				this.ctx.editor.setCustomKeyHandler(key, () => {
					this.ctx.statusLine.toggleMenu(menu.id);
					this.ctx.ui.requestRender();
				});
			}
		}

		for (const key of this.ctx.keybindings.getKeys("resume")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				const hasResumeUiCommand = Boolean(this.ctx.session.extensionRunner?.getCommand("resume-ui"));
				if (hasResumeUiCommand) {
					void this.ctx.session.prompt("/resume-ui").catch(() => {
						this.ctx.showSessionSelector();
					});
					return;
				}
				this.ctx.showSessionSelector();
			});
		}
		for (const key of this.ctx.keybindings.getKeys("followUp")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.handleFollowUp());
		}
		for (const key of this.ctx.keybindings.getKeys("cycleAgentMode")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.cycleAgentMode());
		}
		this.ctx.editor.setCustomKeyHandler("left", () => {
			if (this.ctx.statusLine.getActiveMenu()) {
				this.ctx.statusLine.navigateMenuHorizontal(-1);
				this.ctx.ui.requestRender();
				return true;
			}
			return false;
		});
		this.ctx.editor.setCustomKeyHandler("right", () => {
			if (this.ctx.statusLine.getActiveMenu()) {
				this.ctx.statusLine.navigateMenuHorizontal(1);
				this.ctx.ui.requestRender();
				return true;
			}
			return false;
		});
		this.ctx.editor.setCustomKeyHandler("up", () => {
			if (this.ctx.statusLine.getActiveMenu()) {
				this.ctx.statusLine.navigateMenuVertical(-1);
				this.ctx.ui.requestRender();
				return true;
			}
			return false;
		});
		this.ctx.editor.setCustomKeyHandler("down", () => {
			if (this.ctx.statusLine.getActiveMenu()) {
				this.ctx.statusLine.navigateMenuVertical(1);
				this.ctx.ui.requestRender();
				return true;
			}
			return false;
		});

		// Register Ctrl+X chord as global input listener (above component focus)
		this.#unsubscribeChord = this.ctx.ui.addInputListener((data: string) => {
			return this.#handleChordInput(data);
		});

		this.ctx.editor.onChange = (text: string) => {
			const wasBashMode = this.ctx.isBashMode;
			const wasPythonMode = this.ctx.isPythonMode;
			const trimmed = text.trimStart();
			this.ctx.isBashMode = text.trimStart().startsWith("!");
			this.ctx.isPythonMode = trimmed.startsWith("$") && !trimmed.startsWith("${");
			if (wasBashMode !== this.ctx.isBashMode || wasPythonMode !== this.ctx.isPythonMode) {
				this.ctx.updateEditorBorderColor();
			}
		};
	}

	setupEditorSubmitHandler(): void {
		this.ctx.editor.onSubmit = async (text: string) => {
			if (this.ctx.statusLine.getActiveMenu()) {
				const action = this.ctx.statusLine.executeSelectedMenuAction();
				if (action) {
					if (action.editorText) {
						this.ctx.editor.setText(action.editorText);
					} else {
						void this.ctx.session.prompt(action.command);
					}
				}
				this.ctx.ui.requestRender();
				return;
			}
			text = text.trim();

			// Empty submit while streaming with queued messages: flush queues immediately
			if (!text && this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount > 0) {
				// Abort current stream and let queued messages be processed
				await this.ctx.session.abort();
				return;
			}

			if (!text) return;

			// Continue shortcuts: "." or "c" sends empty message (agent continues, no visible message)
			if (text === "." || text === "c") {
				if (this.ctx.onInputCallback) {
					this.ctx.editor.setText("");
					this.ctx.pendingImages = [];
					this.ctx.onInputCallback({ text: "" });
				}
				return;
			}

			const runner = this.ctx.session.extensionRunner;
			let inputImages = this.ctx.pendingImages.length > 0 ? [...this.ctx.pendingImages] : undefined;

			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, inputImages, "interactive");
				if (result?.handled) {
					this.ctx.editor.setText("");
					this.ctx.pendingImages = [];
					return;
				}
				if (result?.text !== undefined) {
					text = result.text.trim();
				}
				if (result?.images !== undefined) {
					inputImages = result.images;
				}
			}

			if (!text) return;

			// Handle slash commands
			if (text === "/settings") {
				this.ctx.showSettingsSelector();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/plan") {
				await this.ctx.handlePlanModeCommand();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/lazygit") {
				this.ctx.editor.setText("");
				void this.openLazygit();
				return;
			}
			if (text === "/model" || text === "/models") {
				this.ctx.showModelSelector();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/agent" || text.startsWith("/agent ")) {
				const arg = text.slice(6).trim().toLowerCase();
				this.ctx.editor.setText("");
				if (!arg || arg === "toggle") {
					await this.cycleAgentMode();
					return;
				}
				if (arg === "default" || arg === "orchestrator" || arg === "plan" || arg === "ask") {
					await this.switchAgentMode(arg);
					return;
				}
				if (arg === "status") {
					this.showAgentModeStatus();
					return;
				}
				this.ctx.showStatus("Usage: /agent [toggle|default|orchestrator|plan|ask|status]");
				return;
			}
			if (text.startsWith("/export")) {
				await this.ctx.handleExportCommand(text);
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/dump") {
				await this.ctx.handleDumpCommand();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.ctx.handleShareCommand();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/browser" || text.startsWith("/browser ")) {
				const arg = text.slice(8).trim().toLowerCase();
				const current = settings.get("browser.headless" as SettingPath) as boolean;
				let next = current;
				if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
					this.ctx.showWarning("Browser tool is disabled (enable in settings)");
					this.ctx.editor.setText("");
					return;
				}
				if (!arg) {
					next = !current;
				} else if (["headless", "hidden"].includes(arg)) {
					next = true;
				} else if (["visible", "show", "headful"].includes(arg)) {
					next = false;
				} else {
					this.ctx.showStatus("Usage: /browser [headless|visible]");
					this.ctx.editor.setText("");
					return;
				}
				settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
				const tool = this.ctx.session.getToolByName("browser");
				if (tool && "restartForModeChange" in tool) {
					try {
						await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
					} catch (error) {
						this.ctx.showWarning(
							`Failed to restart browser: ${error instanceof Error ? error.message : String(error)}`,
						);
						this.ctx.editor.setText("");
						return;
					}
				}
				this.ctx.showStatus(`Browser mode: ${next ? "headless" : "visible"}`);
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.ctx.handleCopyCommand();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/session") {
				await this.ctx.handleSessionCommand();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/usage") {
				await this.ctx.handleUsageCommand();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/changelog") {
				await this.ctx.handleChangelogCommand();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.ctx.handleHotkeysCommand();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/extensions" || text === "/status") {
				this.ctx.showExtensionsDashboard();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/stt" || text.startsWith("/stt ")) {
				const arg = text.slice(4).trim().toLowerCase();
				this.ctx.editor.setText("");
				if (!arg) {
					await this.toggleSTT();
					return;
				}
				if (arg === "status") {
					this.showSTTStatus();
					return;
				}
				if (arg === "on") {
					await this.toggleSTT({ force: "start" });
					return;
				}
				if (arg === "off") {
					await this.toggleSTT({ force: "stop" });
					return;
				}
				this.ctx.showStatus("Usage: /stt [on|off|status]");
				return;
			}
			if (text === "/branch") {
				if (settings.get("doubleEscapeAction") === "tree") {
					this.ctx.showTreeSelector();
				} else {
					this.ctx.showUserMessageSelector();
				}
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/tree") {
				this.ctx.showTreeSelector();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/login") {
				this.ctx.showOAuthSelector("login");
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/logout") {
				this.ctx.showOAuthSelector("logout");
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/new") {
				this.ctx.editor.setText("");
				await this.ctx.handleClearCommand();
				return;
			}
			if (text === "/fork") {
				this.ctx.editor.setText("");
				await this.ctx.handleForkCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.ctx.editor.setText("");
				await this.ctx.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/handoff" || text.startsWith("/handoff ")) {
				const customInstructions = text.startsWith("/handoff ") ? text.slice(9).trim() : undefined;
				this.ctx.editor.setText("");
				await this.ctx.handleHandoffCommand(customInstructions);
				return;
			}
			if (text === "/background" || text === "/bg") {
				this.ctx.editor.setText("");
				this.handleBackgroundCommand();
				return;
			}
			if (text === "/debug") {
				this.ctx.showDebugSelector();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.ctx.showSessionSelector();
				this.ctx.editor.setText("");
				return;
			}
			if (text === "/quit" || text === "/exit") {
				this.ctx.editor.setText("");
				void this.ctx.shutdown();
				return;
			}

			// Handle skill commands (/skill:name [args])
			if (text.startsWith("/skill:")) {
				const spaceIndex = text.indexOf(" ");
				const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
				const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
				const skillPath = this.ctx.skillCommands?.get(commandName);
				if (skillPath) {
					this.ctx.editor.addToHistory(text);
					this.ctx.editor.setText("");
					try {
						const content = await Bun.file(skillPath).text();
						const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
						const metaLines = [`Skill: ${skillPath}`];
						if (args) {
							metaLines.push(`User: ${args}`);
						}
						const message = `${body}\n\n---\n\n${metaLines.join("\n")}`;
						const skillName = commandName.slice("skill:".length);
						const details: SkillPromptDetails = {
							name: skillName || commandName,
							path: skillPath,
							args: args || undefined,
							lineCount: body ? body.split("\n").length : 0,
						};
						await this.ctx.session.promptCustomMessage(
							{
								customType: SKILL_PROMPT_MESSAGE_TYPE,
								content: message,
								display: true,
								details,
							},
							{ streamingBehavior: "followUp" },
						);
					} catch (err) {
						this.ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.ctx.session.isBashRunning) {
						this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handleBashCommand(command, isExcluded);
					this.ctx.isBashMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			// Handle python command ($ for normal, $$ for excluded from context)
			if (text.startsWith("$")) {
				const isExcluded = text.startsWith("$$");
				const code = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (code) {
					if (this.ctx.session.isPythonRunning) {
						this.ctx.showWarning("A Python execution is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handlePythonCommand(code, isExcluded);
					this.ctx.isPythonMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction
			if (this.ctx.session.isCompacting) {
				if (this.ctx.pendingImages.length > 0) {
					this.ctx.showStatus("Compaction in progress. Retry after it completes to send images.");
					return;
				}
				this.ctx.queueCompactionMessage(text, "steer");
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.ctx.session.isStreaming) {
				this.ctx.editor.addToHistory(text);
				this.ctx.editor.setText("");
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.pendingImages = [];
				await this.ctx.session.prompt(text, { streamingBehavior: "steer", images });
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.ctx.flushPendingBashComponents();

			// Generate session title on first message
			const hasUserMessages = this.ctx.agent.state.messages.some((m: AgentMessage) => m.role === "user");
			if (!hasUserMessages && !this.ctx.sessionManager.getSessionName() && !$env.PI_NO_TITLE) {
				const registry = this.ctx.session.modelRegistry;
				const curatorModel = this.ctx.settings.getModelRole("curator");
				generateSessionTitle(text, registry, curatorModel, this.ctx.session.sessionId)
					.then(async title => {
						if (title) {
							await this.ctx.sessionManager.setSessionName(title);
							setTerminalTitle(`π: ${title}`);
						}
					})
					.catch(() => {});
			}

			if (this.ctx.onInputCallback) {
				// Include any pending images from clipboard paste
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.pendingImages = [];
				this.ctx.onInputCallback({ text, images });
			}
			this.ctx.editor.addToHistory(text);
		};
	}

	handleCtrlC(): void {
		const now = Date.now();
		if (now - this.ctx.lastSigintTime < 500) {
			void this.ctx.shutdown();
		} else {
			this.ctx.clearEditor();
			this.ctx.lastSigintTime = now;
		}
	}

	async toggleSTT(options?: { force?: "start" | "stop" }): Promise<void> {
		const enabled = settings.get("stt.enabled") as boolean;
		if (!enabled) {
			this.ctx.showWarning("Speech-to-text is disabled. Enable it in settings first.");
			return;
		}

		const state = this.#sttController.state;
		if (options?.force === "start" && state !== "idle") {
			if (state === "recording") {
				this.ctx.showStatus("Speech-to-text is already recording.");
			} else {
				this.ctx.showStatus("Speech-to-text is already transcribing.");
			}
			return;
		}
		if (options?.force === "stop" && state === "idle") {
			this.ctx.showStatus("Speech-to-text is already idle.");
			return;
		}
		if (options?.force === "stop" && state === "transcribing") {
			this.ctx.showStatus("Speech-to-text is already transcribing.");
			return;
		}
		await this.#runSTTToggle();
	}

	showSTTStatus(): void {
		const enabled = settings.get("stt.enabled") as boolean;
		if (!enabled) {
			this.ctx.showStatus("Speech-to-text is disabled.");
			return;
		}
		const labels: Record<SttState, string> = {
			idle: "idle",
			recording: "recording",
			transcribing: "transcribing",
		};
		this.ctx.showStatus(`Speech-to-text: ${labels[this.#sttController.state]}`);
	}

	async #runSTTToggle(): Promise<void> {
		await this.#sttController.toggle(this.ctx.editor, {
			showWarning: msg => this.ctx.showWarning(msg),
			showStatus: msg => this.ctx.showStatus(msg),
			onStateChange: state => this.#handleSTTStateChange(state),
		});
	}

	#handleSTTStateChange(state: SttState): void {
		switch (state) {
			case "idle":
				this.ctx.showStatus("");
				break;
			case "recording":
				this.ctx.showStatus(`${theme.symbol("icon.mic")} Recording… Press Alt+H again to transcribe.`, {
					dim: false,
				});
				break;
			case "transcribing":
				this.ctx.showStatus(`${theme.symbol("icon.mic")} Transcribing…`, { dim: false });
				break;
		}
	}

	handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.ctx.shutdown();
	}

	handleCtrlZ(): void {
		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
		});

		// Stop the TUI (restore terminal to normal mode)
		this.ctx.ui.stop();

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	}

	handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.ctx.showStatus("No queued messages to restore");
		} else {
			this.ctx.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	#handleChordInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (data === CTRL_X_BYTE) {
			// State-B: subagent view already active → immediately exit
			if (this.ctx.isSubagentViewActive()) {
				this.ctx.exitSubagentView();
				return { consume: true };
			}
			// State-A: arm chord
			this.#armChord();
			return { consume: true };
		}

		if (this.#chordArmed) {
			this.#disarmChord();
			switch (data) {
				case CTRL_N_BYTE:
					void this.ctx.openSubagentViewerForRoot(1);
					return { consume: true };
				case CTRL_P_BYTE:
					void this.ctx.openSubagentViewerForRoot(-1);
					return { consume: true };
				case CTRL_O_BYTE:
					void this.ctx.openSubagentViewerNewest();
					return { consume: true };
				case CTRL_R_BYTE:
					this.ctx.requestSubagentRefresh("manual");
					return { consume: true };
				case CTRL_V_BYTE:
					this.ctx.openSubagentNavigator();
					return { consume: true };
				case ESC_BYTE:
					// Cancel chord, no action
					return { consume: true };
				default:
					// Unknown follow-up: disarm and don't consume
					return undefined;
			}
		}

		return undefined;
	}

	#armChord(): void {
		this.#disarmChord();
		this.#chordArmed = true;
		this.#chordTimer = setTimeout(() => {
			this.#chordArmed = false;
			this.#chordTimer = undefined;
			this.ctx.openSubagentNavigator();
		}, CTRLX_CHORD_TIMEOUT_MS);
	}

	#disarmChord(): void {
		this.#chordArmed = false;
		if (this.#chordTimer !== undefined) {
			clearTimeout(this.#chordTimer);
			this.#chordTimer = undefined;
		}
	}

	dispose(): void {
		this.#disarmChord();
		if (this.#unsubscribeChord) {
			this.#unsubscribeChord();
			this.#unsubscribeChord = undefined;
		}
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	async handleFollowUp(): Promise<void> {
		const text = this.ctx.editor.getText().trim();
		if (!text) return;

		if (this.ctx.session.isCompacting) {
			this.ctx.queueCompactionMessage(text, "followUp");
			return;
		}

		if (this.ctx.session.isStreaming) {
			this.ctx.editor.addToHistory(text);
			this.ctx.editor.setText("");
			await this.ctx.session.prompt(text, { streamingBehavior: "followUp" });
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		// Not streaming — just submit normally
		this.ctx.editor.addToHistory(text);
		this.ctx.editor.setText("");
		await this.ctx.session.prompt(text);
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.ctx.session.clearQueue();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.ctx.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
		this.ctx.editor.setText(combinedText);
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.ctx.agent.abort();
		}
		return allQueued.length;
	}

	handleBackgroundCommand(): void {
		if (this.ctx.isBackgrounded) {
			this.ctx.showStatus("Background mode already enabled");
			return;
		}
		if (!this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0) {
			this.ctx.showWarning("Agent is idle; nothing to background");
			return;
		}

		this.ctx.isBackgrounded = true;
		const backgroundUiContext = this.ctx.createBackgroundUiContext();

		// Background mode disables interactive UI so tools like ask fail fast.
		this.ctx.setToolUIContext(backgroundUiContext, false);
		this.ctx.initializeHookRunner(backgroundUiContext, false);

		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
		}
		this.ctx.statusContainer.clear();
		this.ctx.statusLine.dispose();

		if (this.ctx.unsubscribe) {
			this.ctx.unsubscribe();
		}
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.ctx.handleBackgroundEvent(event);
		});

		// Backgrounding keeps the current process to preserve in-flight agent state.
		if (this.ctx.isInitialized) {
			this.ctx.ui.stop();
			this.ctx.isInitialized = false;
		}

		process.stdout.write("Background mode enabled. Run `bg` to continue in background.\n");

		if (process.platform === "win32" || !process.stdout.isTTY) {
			process.stdout.write("Backgrounding requires POSIX job control; continuing in foreground.\n");
			return;
		}

		process.kill(0, "SIGTSTP");
	}

	async handleImagePaste(): Promise<boolean> {
		try {
			const image = await readImageFromClipboard();
			if (image) {
				const base64Data = image.data.toBase64();
				let imageData = { data: base64Data, mimeType: image.mimeType };
				if (settings.get("images.autoResize")) {
					try {
						const resized = await resizeImage({
							type: "image",
							data: base64Data,
							mimeType: image.mimeType,
						});
						imageData = { data: resized.data, mimeType: resized.mimeType };
					} catch {
						imageData = { data: base64Data, mimeType: image.mimeType };
					}
				}

				this.ctx.pendingImages.push({
					type: "image",
					data: imageData.data,
					mimeType: imageData.mimeType,
				});
				// Insert placeholder at cursor like Claude does
				const imageNum = this.ctx.pendingImages.length;
				const placeholder = `[Image #${imageNum}]`;
				this.ctx.editor.insertText(`${placeholder} `);
				this.ctx.ui.requestRender();
				return true;
			}
			// No image in clipboard - show hint
			this.ctx.showStatus("No image in clipboard (use terminal paste for text)");
			return false;
		} catch {
			this.ctx.showStatus("Failed to read clipboard");
			return false;
		}
	}

	cycleThinkingLevel(): void {
		const newLevel = this.ctx.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.ctx.showStatus("Current model does not support thinking");
		} else {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}
	}

	async cycleRoleModel(options?: { temporary?: boolean }): Promise<void> {
		try {
			const roleOrder = ["orchestrator", "default", "explore"] as const;
			const result = await this.ctx.session.cycleRoleModels(roleOrder, options);
			if (!result) {
				this.ctx.showStatus("Only one role model available");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			const roleLabel = result.role === "default" ? "default" : result.role;
			const roleLabelStyled = theme.bold(theme.fg("accent", roleLabel));
			const thinkingStr =
				result.model.thinking && result.thinkingLevel !== ThinkingLevel.Off
					? ` (thinking: ${result.thinkingLevel})`
					: "";
			const tempLabel = options?.temporary ? " (temporary)" : "";
			const cycleSeparator = theme.fg("dim", " > ");
			const cycleLabel = roleOrder
				.map(role => {
					if (role === result.role) {
						return theme.bold(theme.fg("accent", role));
					}
					return theme.fg("muted", role);
				})
				.join(cycleSeparator);
			const orderLabel = ` (cycle: ${cycleLabel})`;
			this.ctx.showStatus(
				`Switched to ${roleLabelStyled}: ${result.model.name || result.model.id}${thinkingStr}${tempLabel}${orderLabel}`,
				{ dim: false },
			);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	async cycleAgentMode(): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish before switching agent mode.");
			return;
		}
		const cycleOrder: Array<"default" | "ask" | "orchestrator" | "plan"> = ["default", "orchestrator", "plan", "ask"];
		const currentRole = this.resolveCurrentAgentRole();
		const normalizedRole = currentRole === "custom" ? "default" : currentRole;
		const currentIndex = cycleOrder.indexOf(normalizedRole);
		const nextRole = cycleOrder[(currentIndex + 1) % cycleOrder.length];
		await this.switchAgentMode(nextRole, { bypassAskRestore: true });
	}

	private resolveCurrentAgentRole(): "default" | "ask" | "orchestrator" | "plan" | "custom" {
		const defaultModel = this.ctx.session.resolveRoleModel("default");
		const askModel = this.ctx.session.resolveRoleModel("ask");
		const orchestratorModel = this.ctx.session.resolveRoleModel("orchestrator");
		const planModel = this.ctx.session.resolveRoleModel("plan");

		const lastRole = this.ctx.sessionManager.getLastModelChangeRole();
		if (lastRole === "default" || lastRole === "ask" || lastRole === "orchestrator" || lastRole === "plan") {
			return lastRole;
		}

		const currentModel = this.ctx.session.model;
		if (defaultModel && currentModel?.provider === defaultModel.provider && currentModel?.id === defaultModel.id) {
			return "default";
		}
		if (askModel && currentModel?.provider === askModel.provider && currentModel?.id === askModel.id) {
			return "ask";
		}
		if (
			orchestratorModel &&
			currentModel?.provider === orchestratorModel.provider &&
			currentModel?.id === orchestratorModel.id
		) {
			return "orchestrator";
		}
		if (planModel && currentModel?.provider === planModel.provider && currentModel?.id === planModel.id) {
			return "plan";
		}
		return "custom";
	}

	private showAgentModeStatus(): void {
		const role = this.resolveCurrentAgentRole();
		const model = this.ctx.session.model;
		const modelLabel = model ? model.name || model.id : "no-model";
		this.ctx.showStatus(`Agent mode: ${theme.bold(theme.fg("accent", role))} (${modelLabel})`, { dim: false });
	}

	private async switchAgentMode(
		targetRole: "default" | "ask" | "orchestrator" | "plan",
		options?: { bypassAskRestore?: boolean },
	): Promise<void> {
		if (!options?.bypassAskRestore && targetRole !== "ask" && this.#isAskModeActive()) {
			await this.#restoreAskMode();
			return;
		}

		const configuredDefaultRole = settings.getModelRole("default");
		const configuredAskRole = settings.getModelRole("ask");
		const configuredOrchestratorRole = settings.getModelRole("orchestrator");
		const configuredPlanRole = settings.getModelRole("plan");
		if (targetRole !== "ask" && (!configuredDefaultRole || !configuredOrchestratorRole)) {
			this.ctx.showWarning("Configure both default and orchestrator role models first (use /model).");
			return;
		}
		if (targetRole === "plan" && !configuredPlanRole) {
			this.ctx.showWarning("Configure the plan role model first (use /model -> Set as Plan).");
			return;
		}
		if (targetRole === "ask" && !configuredAskRole && !configuredDefaultRole) {
			this.ctx.showWarning("Configure an ask role model (or set a default model) first via /model.");
			return;
		}

		const defaultModel = this.ctx.session.resolveRoleModel("default");
		const askModel = this.ctx.session.resolveRoleModel("ask") ?? defaultModel;
		const orchestratorModel = this.ctx.session.resolveRoleModel("orchestrator");
		const planModel = this.ctx.session.resolveRoleModel("plan");
		if (targetRole !== "ask" && (!defaultModel || !orchestratorModel)) {
			this.ctx.showWarning(
				"Configured default/orchestrator model is unavailable (check API keys and /model assignments).",
			);
			return;
		}
		if (targetRole === "plan" && !planModel) {
			this.ctx.showWarning("Plan role model is unavailable (check API keys and /model assignments).");
			return;
		}
		if (targetRole === "ask" && !askModel) {
			this.ctx.showWarning("Ask role model is unavailable (check API keys and /model assignments).");
			return;
		}

		const nextModel =
			targetRole === "orchestrator"
				? orchestratorModel!
				: targetRole === "plan"
					? planModel!
					: targetRole === "ask"
						? askModel!
						: defaultModel!;
		const nextModelRef = `${nextModel.provider}/${nextModel.id}`;

		try {
			await this.ctx.session.setModelTemporary(nextModel);
			this.ctx.sessionManager.appendModelChange(nextModelRef, targetRole);
			if (targetRole !== "ask") {
				this.#clearAskModeState();
			}
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			const modelLabel = nextModel.name || nextModel.id;
			this.ctx.showStatus(
				`Agent mode: ${theme.bold(theme.fg("accent", targetRole))} (${modelLabel}) · session only (/model controls defaults)`,
				{ dim: false },
			);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	async #toggleAskMode(): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish before switching agent mode.");
			return;
		}
		if (this.#isAskModeActive()) {
			await this.#restoreAskMode();
			return;
		}
		this.#askModePreviousRole = this.resolveCurrentAgentRole();
		this.#askModePreviousModel = this.ctx.session.model;
		await this.switchAgentMode("ask", { bypassAskRestore: true });
	}

	async #restoreAskMode(): Promise<void> {
		const previousRole = this.#askModePreviousRole;
		const previousModel = this.#askModePreviousModel;
		this.#clearAskModeState();

		if (previousRole === "default" || previousRole === "orchestrator" || previousRole === "plan") {
			await this.switchAgentMode(previousRole, { bypassAskRestore: true });
			return;
		}

		if (!previousModel) {
			await this.switchAgentMode("default", { bypassAskRestore: true });
			return;
		}

		try {
			await this.ctx.session.setModelTemporary(previousModel);
			this.ctx.sessionManager.appendModelChange(`${previousModel.provider}/${previousModel.id}`, "custom");
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			const modelLabel = previousModel.name || previousModel.id;
			this.ctx.showStatus(
				`Agent mode: ${theme.bold(theme.fg("accent", "custom"))} (${modelLabel}) · session only (/model controls defaults)`,
				{ dim: false },
			);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	#isAskModeActive(): boolean {
		return this.resolveCurrentAgentRole() === "ask";
	}

	#clearAskModeState(): void {
		this.#askModePreviousRole = undefined;
		this.#askModePreviousModel = undefined;
	}

	toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.ctx.toolOutputExpanded);
	}

	setToolsExpanded(expanded: boolean): void {
		this.ctx.toolOutputExpanded = expanded;
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ctx.ui.requestRender();
	}

	toggleThinkingBlockVisibility(): void {
		this.ctx.hideThinkingBlock = !this.ctx.hideThinkingBlock;
		settings.set("hideThinkingBlock", this.ctx.hideThinkingBlock);

		// Rebuild chat from session messages
		this.ctx.chatContainer.clear();
		this.ctx.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
		}

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	private async openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	async openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.ctx.editor.getText();

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.openEditorTerminalHandle();
			this.ctx.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, { extension: ".omp.md", stdio });
			if (result !== null) {
				this.ctx.editor.setText(result);
			}
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}

			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	async openLazygit(): Promise<void> {
		if (!Bun.which("lazygit")) {
			const installCmd = detectLazygitInstallCommand();
			if (!installCmd || !process.stdin.isTTY || !process.stdout.isTTY) {
				this.ctx.showWarning(
					"lazygit not found. Install it: https://github.com/jesseduffield/lazygit#installation",
				);
				return;
			}

			let closePrompt = null;
			let shouldLaunchLazygit = false;
			try {
				this.ctx.ui.stop();

				const rl = readlinePromises.createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				closePrompt = () => rl.close();

				const cmdStr = [installCmd.command, ...installCmd.args].join(" ");
				process.stdout.write(`lazygit is not installed.\n`);
				const answer = await rl.question(`Would you like to install it now? [Y/n] (${cmdStr}): `);

				if (answer.trim().toLowerCase() === "n") {
					return;
				}

				process.stdout.write(`\nRunning: ${cmdStr}\n`);

				await new Promise<void>((resolve, reject) => {
					const child = spawn(installCmd.command, installCmd.args, {
						stdio: "inherit",
					});
					child.once("exit", code => {
						if (code === 0) resolve();
						else reject(new Error(`Install command exited with code ${code}`));
					});
					child.once("error", reject);
				});

				shouldLaunchLazygit = true;
			} catch (error) {
				this.ctx.showWarning(
					`Failed to install lazygit: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			} finally {
				closePrompt?.();
				if (!shouldLaunchLazygit) {
					this.ctx.ui.start();
					this.ctx.ui.requestRender();
				}
			}
		}

		const cwd = getProjectDir();
		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.openEditorTerminalHandle();
			this.ctx.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];
			const env = { ...process.env };
			delete env.GIT_DIR;
			delete env.GIT_WORK_TREE;

			await new Promise<void>((resolve, reject) => {
				const child = spawn("lazygit", ["-p", cwd], { stdio, env });
				child.once("exit", () => resolve());
				child.once("error", reject);
			});
		} catch (error) {
			this.ctx.showWarning(`Failed to open lazygit: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (ttyHandle) {
				try {
					await ttyHandle.close();
				} catch (error) {
					this.ctx.showWarning(
						`Failed to close lazygit terminal handle: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	registerExtensionShortcuts(): void {
		const runner = this.ctx.session.extensionRunner;
		if (!runner) return;

		const shortcuts = runner.getShortcuts();
		for (const [keyId, shortcut] of shortcuts) {
			this.ctx.editor.setCustomKeyHandler(keyId, () => {
				const ctx = runner.createCommandContext();
				try {
					shortcut.handler(ctx);
				} catch (err) {
					runner.emitError({
						extensionPath: shortcut.extensionPath,
						event: "shortcut",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			});
		}
	}
}
