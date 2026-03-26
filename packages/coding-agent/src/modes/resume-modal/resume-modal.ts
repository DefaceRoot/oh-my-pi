import { Container, matchesKey } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme.js";
import type { SessionInfo } from "../../session/session-manager.js";
import {
	composePanels,
	renderDetailPanel,
	renderFooter,
	renderHeader,
	renderProjectSidebar,
	renderSessionList,
} from "./resume-modal-renderers.js";
import {
	buildColumnSpec,
	buildProjectGroups,
	type ProjectGroup,
	type ResumeModalState,
	type ResumeSessionEntry,
} from "./resume-modal-types.js";

type ResumeModalCallbacks = {
	onSelect: (sessionPath: string, sessionCwd: string) => void;
	onClose: () => void;
};

const DEFAULT_BODY_HEIGHT = 20;

/**
 * Main ResumeModal component that orchestrates the resume experience.
 */
export class ResumeModal extends Container {
	public _state: ResumeModalState;
	public _onSelect: (sessionPath: string, sessionCwd: string) => void;
	public _onClose: () => void;

	constructor(sessionsMap: Map<string, SessionInfo[]>, currentCwd: string, callbacks: ResumeModalCallbacks) {
		super();
		this._onSelect = callbacks.onSelect;
		this._onClose = callbacks.onClose;

		const projects = buildProjectGroups(sessionsMap, currentCwd);
		const currentProjectIndex = projects.findIndex(project => project.isCurrentProject);

		this._state = {
			projects,
			selectedProjectIndex: currentProjectIndex >= 0 ? currentProjectIndex : 0,
			selectedSessionIndex: 0,
			scrollOffset: 0,
			filterText: "",
			filterMode: false,
			showArchived: false,
			focusPanel: "sessions",
			layoutMode: "full",
		};
	}

	updateSessions(sessionsMap: Map<string, SessionInfo[]>, currentCwd: string): void {
		const projects = buildProjectGroups(sessionsMap, currentCwd);
		const currentProjectIndex = projects.findIndex(project => project.isCurrentProject);

		this._state.projects = projects;
		this._state.selectedProjectIndex = currentProjectIndex >= 0 ? currentProjectIndex : 0;
		this._state.selectedSessionIndex = 0;
		this._state.scrollOffset = 0;
		if (projects.length === 0) {
			this._state.focusPanel = "sessions";
		}

		this._clampIndices();
		this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(3, width);
		const colSpec = buildColumnSpec(safeWidth);
		const mode = colSpec.showSidebar ? (colSpec.showDetail ? "full" : "compact") : "narrow";

		if (this._state.layoutMode !== mode) {
			this._state.layoutMode = mode;
			if (mode === "narrow" && this._state.focusPanel !== "sessions") {
				this._state.focusPanel = "sessions";
			} else if (mode === "compact" && this._state.focusPanel === "detail") {
				this._state.focusPanel = "sessions";
			}
		}

		this._clampIndices(DEFAULT_BODY_HEIGHT);

		const bodyHeight = DEFAULT_BODY_HEIGHT;
		const innerWidth = safeWidth - 2;

		const headerLines = renderHeader(innerWidth, this._state.filterMode, this._state.filterText);

		const currentProject = this._state.projects[this._state.selectedProjectIndex];
		const visibleSessions = this._getVisibleSessions(currentProject);

		const sidebarLines = colSpec.showSidebar
			? renderProjectSidebar(
					this._state.projects,
					this._state.selectedProjectIndex,
					bodyHeight,
					colSpec.sidebarWidth,
					this._state.focusPanel === "projects",
				)
			: [];

		const listLines = renderSessionList(
			visibleSessions,
			this._state.selectedSessionIndex,
			this._state.scrollOffset,
			bodyHeight,
			colSpec.listWidth,
			this._state.focusPanel === "sessions",
			this._state.showArchived,
		);

		const detailLines = colSpec.showDetail
			? renderDetailPanel(this._getSelectedSession(), bodyHeight, colSpec.detailWidth)
			: [];

		const panelLines = composePanels(sidebarLines, listLines, detailLines, colSpec, innerWidth);

		const footerLines = renderFooter(innerWidth, this._state.layoutMode);
		const lines = [...headerLines, ...panelLines, ...footerLines];

		return lines.map(line => theme.overlaySurface(line));
	}

	handleInput(keyData: string): void {
		if (this._state.filterMode) {
			this._handleFilterInput(keyData);
			return;
		}
		this._handleListInput(keyData);
	}

	private _handleFilterInput(keyData: string): void {
		if (
			matchesKey(keyData, "escape") ||
			matchesKey(keyData, "esc") ||
			matchesKey(keyData, "enter") ||
			matchesKey(keyData, "return") ||
			keyData === "\n"
		) {
			this._state.filterMode = false;
			this._clampIndices();
			this.invalidate();
			return;
		}

		if (matchesKey(keyData, "backspace") || matchesKey(keyData, "delete")) {
			this._state.filterText = this._state.filterText.slice(0, -1);
			this._state.selectedSessionIndex = 0;
			this._state.scrollOffset = 0;
			this._clampIndices();
			this.invalidate();
			return;
		}

		if (keyData.length === 1 && !matchesKey(keyData, "tab")) {
			this._state.filterText += keyData;
			this._state.selectedSessionIndex = 0;
			this._state.scrollOffset = 0;
			this._clampIndices();
			this.invalidate();
		}
	}

	private _handleListInput(keyData: string): void {
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || keyData === "q") {
			this._onClose();
			return;
		}

		if (matchesKey(keyData, "ctrl+c")) {
			this._onClose();
			return;
		}

		if (keyData === "/") {
			this._state.filterMode = true;
			this.invalidate();
			return;
		}

		if (keyData === "a" || keyData === "A") {
			this._state.showArchived = !this._state.showArchived;
			this._state.selectedSessionIndex = 0;
			this._state.scrollOffset = 0;
			this._clampIndices();
			this.invalidate();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedSession = this._getSelectedSession();
			if (selectedSession) {
				this._onSelect(selectedSession.session.path, selectedSession.session.cwd);
			}
			return;
		}

		const isNarrow = this._state.layoutMode === "narrow";

		if (this._state.focusPanel === "projects") {
			if (matchesKey(keyData, "up") || keyData === "k") {
				this._state.selectedProjectIndex = Math.max(0, this._state.selectedProjectIndex - 1);
				this._state.selectedSessionIndex = 0;
				this._state.scrollOffset = 0;
			} else if (matchesKey(keyData, "down") || keyData === "j") {
				this._state.selectedProjectIndex = Math.min(
					this._state.projects.length - 1,
					this._state.selectedProjectIndex + 1,
				);
				this._state.selectedSessionIndex = 0;
				this._state.scrollOffset = 0;
			} else if (matchesKey(keyData, "right") || keyData === "l" || matchesKey(keyData, "tab")) {
				this._state.focusPanel = "sessions";
			}
		} else if (this._state.focusPanel === "sessions") {
			const currentProject = this._state.projects[this._state.selectedProjectIndex];
			const visibleSessions = this._getVisibleSessions(currentProject);
			const sessionCount = visibleSessions.length;

			if (matchesKey(keyData, "up") || keyData === "k") {
				if (this._state.selectedSessionIndex > 0) {
					this._state.selectedSessionIndex -= 1;
				} else if (!isNarrow && this._state.selectedProjectIndex > 0) {
					this._state.selectedProjectIndex -= 1;
					const prevProject = this._state.projects[this._state.selectedProjectIndex];
					const prevSessionCount = this._getVisibleSessions(prevProject).length;
					this._state.selectedSessionIndex = Math.max(0, prevSessionCount - 1);
					this._state.scrollOffset = 0;
				}
			} else if (matchesKey(keyData, "down") || keyData === "j") {
				if (this._state.selectedSessionIndex < sessionCount - 1) {
					this._state.selectedSessionIndex += 1;
				} else if (!isNarrow && this._state.selectedProjectIndex < this._state.projects.length - 1) {
					this._state.selectedProjectIndex += 1;
					this._state.selectedSessionIndex = 0;
					this._state.scrollOffset = 0;
				}
			} else if (matchesKey(keyData, "left") || keyData === "h" || matchesKey(keyData, "shift+tab")) {
				if (!isNarrow) {
					this._state.focusPanel = "projects";
				}
			} else if ((matchesKey(keyData, "right") || keyData === "l") && this._state.layoutMode === "full") {
				this._state.focusPanel = "detail";
			}
		} else if (this._state.focusPanel === "detail") {
			if (
				matchesKey(keyData, "left") ||
				keyData === "h" ||
				matchesKey(keyData, "shift+tab") ||
				matchesKey(keyData, "tab")
			) {
				this._state.focusPanel = "sessions";
			}
		}

		this._clampIndices(DEFAULT_BODY_HEIGHT);
		this.invalidate();
	}

	private _getVisibleSessions(project: ProjectGroup | undefined): ResumeSessionEntry[] {
		if (!project) return [];

		let sessions = this._state.showArchived
			? project.sessions
			: project.sessions.filter(session => !session.isArchived);

		if (this._state.filterText.trim()) {
			const query = this._state.filterText.toLowerCase();
			sessions = sessions.filter(session => {
				return [
					session.displayTitle,
					session.session.id,
					session.session.cwd,
					session.session.firstMessage,
					session.session.branch,
				]
					.filter((value): value is string => Boolean(value))
					.some(value => value.toLowerCase().includes(query));
			});
		}

		return sessions;
	}

	private _syncScrollOffset(bodyHeight: number, sessionCount: number): void {
		if (bodyHeight <= 0 || sessionCount <= 0) {
			this._state.scrollOffset = 0;
			return;
		}

		if (this._state.selectedSessionIndex < this._state.scrollOffset) {
			this._state.scrollOffset = this._state.selectedSessionIndex;
		}

		if (this._state.selectedSessionIndex >= this._state.scrollOffset + bodyHeight) {
			this._state.scrollOffset = this._state.selectedSessionIndex - bodyHeight + 1;
		}

		const maxOffset = Math.max(0, sessionCount - bodyHeight);
		this._state.scrollOffset = Math.max(0, Math.min(this._state.scrollOffset, maxOffset));
	}

	private _clampIndices(bodyHeight: number = DEFAULT_BODY_HEIGHT): void {
		if (this._state.projects.length === 0) {
			this._state.selectedProjectIndex = 0;
			this._state.selectedSessionIndex = 0;
			this._state.scrollOffset = 0;
			return;
		}

		this._state.selectedProjectIndex = Math.max(
			0,
			Math.min(this._state.selectedProjectIndex, this._state.projects.length - 1),
		);

		const currentProject = this._state.projects[this._state.selectedProjectIndex];
		const visibleSessions = this._getVisibleSessions(currentProject);

		if (visibleSessions.length === 0) {
			this._state.selectedSessionIndex = 0;
			this._state.scrollOffset = 0;
			return;
		}

		this._state.selectedSessionIndex = Math.max(
			0,
			Math.min(this._state.selectedSessionIndex, visibleSessions.length - 1),
		);

		this._syncScrollOffset(bodyHeight, visibleSessions.length);
	}

	private _getSelectedSession(): ResumeSessionEntry | undefined {
		const project = this._state.projects[this._state.selectedProjectIndex];
		if (!project) return undefined;
		const visibleSessions = this._getVisibleSessions(project);
		return visibleSessions[this._state.selectedSessionIndex];
	}
}
