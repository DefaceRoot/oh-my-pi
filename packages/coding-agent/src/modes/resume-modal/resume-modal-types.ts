import type { SessionInfo } from "../../session/session-manager.js";

/** Enriched session with computed display fields */
export interface ResumeSessionEntry {
  session: SessionInfo;
  worktreeGroup: string;     // "main" or worktree branch name
  isArchived: boolean;       // modified > 7 days ago
  displayTitle: string;      // title ?? firstMessage truncated
  timeAgo: string;           // "2m ago", "3h ago", "5d ago"
  timeColor: TimeColor;      // for color coding
}

export type TimeColor = "success" | "warning" | "muted" | "dim";
export type AgentMode = "orchestrator" | "default" | "unknown";

/** Focus panel for keyboard navigation */
export type FocusPanel = "projects" | "sessions" | "detail";

/** Layout mode based on terminal width */
export type LayoutMode = "full" | "compact" | "narrow";

export interface ProjectGroup {
  path: string;           // Full decoded CWD path
  displayName: string;    // Shortened for display (last 2 path segments)
  sessions: ResumeSessionEntry[];
  isCurrentProject: boolean;
}

export interface ResumeModalState {
  projects: ProjectGroup[];
  selectedProjectIndex: number;
  selectedSessionIndex: number;
  scrollOffset: number;
  filterText: string;
  filterMode: boolean;
  showArchived: boolean;
  focusPanel: FocusPanel;
  layoutMode: LayoutMode;
}

/** Column widths for responsive layout */
export interface ModalColumnSpec {
  sidebarWidth: number;
  listWidth: number;
  detailWidth: number;
  showSidebar: boolean;
  showDetail: boolean;
}

export const ARCHIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Compute relative time string and color */
export function formatTimeAgo(date: Date): { text: string; color: TimeColor } {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffMins < 1) {
    return { text: "just now", color: "success" };
  }
  if (diffMins < 60) {
    return { text: `${diffMins}m ago`, color: "success" };
  }
  if (diffHours < 24) {
    return { text: `${diffHours}h ago`, color: "warning" };
  }
  if (diffDays < 2) {
    return { text: "1d ago", color: "muted" };
  }
  if (diffDays < 7) {
    return { text: `${diffDays}d ago`, color: "muted" };
  }
  
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return { text: formatter.format(date), color: "dim" };
}

/** Detect layout mode from terminal width */
export function getLayoutMode(width: number): LayoutMode {
  if (width >= 120) return "full";
  if (width >= 80) return "compact";
  return "narrow";
}

/** Compute column widths for given terminal width */
export function buildColumnSpec(width: number): ModalColumnSpec {
  const mode = getLayoutMode(width);
  const innerWidth = Math.max(1, width - 2); // minus border
  if (mode === "full") {
    const sidebarWidth = Math.min(24, Math.floor(innerWidth * 0.2));
    const detailWidth = Math.min(42, Math.floor(innerWidth * 0.28));
    const listWidth = innerWidth - sidebarWidth - detailWidth - 2; // 2 for separators
    return { sidebarWidth, listWidth, detailWidth, showSidebar: true, showDetail: true };
  }
  if (mode === "compact") {
    const sidebarWidth = Math.min(22, Math.floor(innerWidth * 0.22));
    const listWidth = innerWidth - sidebarWidth - 1; // 1 separator
    return { sidebarWidth, listWidth, detailWidth: 0, showSidebar: true, showDetail: false };
  }
  return { sidebarWidth: 0, listWidth: innerWidth, detailWidth: 0, showSidebar: false, showDetail: false };
}

/** Shorten a path for display: /home/user/projects/oh-my-pi → oh-my-pi */
export function shortenPath(fullPath: string): string {
  const parts = fullPath.replace(/\/$/, "").split("/");
  // For worktrees: show repo/.worktrees/branch
  const wtIdx = parts.indexOf(".worktrees");
  if (wtIdx >= 0 && wtIdx > 0 && wtIdx < parts.length - 1) {
    return `${parts[wtIdx - 1]}/${parts[wtIdx + 1]}`;
  }
  return parts[parts.length - 1] || fullPath;
}

/** Detect agent mode from modelRole or message content */
export function detectAgentMode(session: SessionInfo): AgentMode {
  if (session.modelRole) {
    const role = session.modelRole.toLowerCase();
    if (role.includes("orchestrator")) return "orchestrator";
    if (role.includes("default") || role.includes("standard")) return "default";
  }
  // Fallback: keyword scan of allMessagesText
  const text = session.allMessagesText || "";
  if (text.includes("Orchestrator mode") || text.includes("implementation-engine/")) return "orchestrator";
  if (text.includes("Default Mode") || text.includes("Default mode")) return "default";
  return "unknown";
}

/** Detect worktree group from CWD path */
export function detectWorktreeGroup(cwd: string): string {
  const parts = cwd.split("/");
  const wtIdx = parts.indexOf(".worktrees");
  if (wtIdx >= 0 && wtIdx < parts.length - 1) {
    return parts[wtIdx + 1]; // branch name
  }
  return "main";
}

/** Fuzzy match for filter */
export function fuzzyMatch(query: string, ...texts: (string | undefined)[]): boolean {
  if (!query) return true;
  const lowerQuery = query.toLowerCase();
  return texts.some(t => t?.toLowerCase().includes(lowerQuery));
}

/** Temp directory prefixes that indicate internal/test sessions */
const TEMP_SESSION_CWD_PATTERNS = [
  "/tmp/pi-auto-compaction-",
  "/tmp/pi-compaction-",
  "/tmp/pi-handoff-",
];

/** Check if a session is a temporary/internal session that should be hidden from the resume UI */
export function isTemporarySession(session: SessionInfo): boolean {
  if (!session.cwd) return false;
  const cwd = session.cwd.toLowerCase();
  return TEMP_SESSION_CWD_PATTERNS.some(pattern => cwd.startsWith(pattern));
}

/** Enrich raw SessionInfo[] into ResumeSessionEntry[] */
export function enrichSessions(sessions: SessionInfo[]): ResumeSessionEntry[] {
  const now = Date.now();
  return sessions.map(session => {
    const modifiedTime = session.modified instanceof Date ? session.modified.getTime() : new Date(session.modified).getTime();
    const isArchived = now - modifiedTime > ARCHIVE_THRESHOLD_MS;
    
    // Create Date object once
    const modifiedDate = session.modified instanceof Date ? session.modified : new Date(session.modified);
    
    const { text: timeAgo, color: timeColor } = formatTimeAgo(modifiedDate);
    
    let displayTitle = session.title;
    if (!displayTitle && session.firstMessage) {
        displayTitle = session.firstMessage.slice(0, 80);
    }
    if (!displayTitle) {
        displayTitle = session.id;
    }
    
    return {
      session,
      worktreeGroup: detectWorktreeGroup(session.cwd),
      isArchived,
      displayTitle,
      timeAgo,
      timeColor,
    };
  });
}

/** Build ProjectGroup[] from Map<string, SessionInfo[]> with current CWD prioritized */
export function buildProjectGroups(
  grouped: Map<string, SessionInfo[]>,
  currentCwd: string,
): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  for (const [projectPath, sessions] of grouped.entries()) {
    const enriched = enrichSessions(sessions.filter(s => !isTemporarySession(s)));
    if (enriched.length === 0) continue;
    groups.push({
      path: projectPath,
      displayName: shortenPath(projectPath),
      sessions: enriched,
      isCurrentProject: currentCwd.startsWith(projectPath) || projectPath.startsWith(currentCwd),
    });
  }
  // Sort: current project first, then by most recent session
  groups.sort((a, b) => {
    if (a.isCurrentProject && !b.isCurrentProject) return -1;
    if (!a.isCurrentProject && b.isCurrentProject) return 1;
    
    const getModTime = (s: ResumeSessionEntry) => 
        s.session.modified instanceof Date ? s.session.modified.getTime() : new Date(s.session.modified).getTime();
        
    const aMax = a.sessions.length > 0 ? Math.max(...a.sessions.map(getModTime)) : 0;
    const bMax = b.sessions.length > 0 ? Math.max(...b.sessions.map(getModTime)) : 0;
    return bMax - aMax;
  });
  return groups;
}