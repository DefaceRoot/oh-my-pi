import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme.js";
import type {
  LayoutMode,
  ModalColumnSpec,
  ProjectGroup,
  ResumeSessionEntry,
  TimeColor,
} from "./resume-modal-types.js";
import { detectAgentMode } from "./resume-modal-types.js";

const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
};

const accent = (text: string): string => theme.fg("accent", text);
const dim = (text: string): string => theme.fg("dim", text);
const muted = (text: string): string => theme.fg("muted", text);
const success = (text: string): string => theme.fg("success", text);
const warning = (text: string): string => theme.fg("warning", text);

const colorizeTime = (text: string, color: TimeColor): string => {
  if (color === "success") return success(text);
  if (color === "warning") return warning(text);
  if (color === "muted") return muted(text);
  return dim(text);
};

const normalizeRowWidth = (row: string, width: number): string => {
  const rowWidth = visibleWidth(row);
  if (rowWidth < width) {
    return row + " ".repeat(width - rowWidth);
  }
  if (rowWidth > width) {
    return truncateToWidth(row, width);
  }
  return row;
};

export function padLine(text: string, targetWidth: number): string {
  const width = visibleWidth(text);
  if (width >= targetWidth) {
    return truncateToWidth(text, targetWidth);
  }
  return text + " ".repeat(targetWidth - width);
}

export function frameLine(content: string, innerWidth: number): string {
  const padded = padLine(content, Math.max(0, innerWidth - 2));
  return `${BOX.vertical} ${padded} ${BOX.vertical}`;
}

export function renderHeader(
  innerWidth: number,
  filterMode: boolean,
  filterText: string,
): string[] {
  const topBorder = `${BOX.topLeft}${BOX.horizontal.repeat(Math.max(0, innerWidth))}${BOX.topRight}`;

  let contentStr = "";
  if (filterMode) {
    contentStr = accent(`/ ${filterText}█`);
  } else {
    const title = theme.bold("Resume Session");
    const rightSide = dim("Ctrl+R");
    const spaceCount = Math.max(
      0,
      innerWidth - 2 - visibleWidth(title) - visibleWidth(rightSide),
    );
    contentStr = title + " ".repeat(spaceCount) + rightSide;
  }

  const paddedContent = padLine(contentStr, Math.max(0, innerWidth - 2));
  const middleLine = `${BOX.vertical} ${paddedContent} ${BOX.vertical}`;

  return [topBorder, middleLine];
}

export function renderFooter(
  innerWidth: number,
  layoutMode: LayoutMode,
): string[] {
  let helpText = "";
  if (layoutMode === "full") {
    helpText =
      "↑↓ Navigate  Tab Focus  / Filter  Enter Resume  A Archived  Esc Close";
  } else if (layoutMode === "compact") {
    helpText = "↑↓ Navigate  Tab Focus  / Filter  Enter Resume  Esc Close";
  } else {
    helpText = "↑↓ Navigate  / Filter  Enter Resume  Esc Close";
  }

  const paddedHelp = padLine(dim(helpText), Math.max(0, innerWidth - 2));
  const textLine = `${BOX.vertical} ${paddedHelp} ${BOX.vertical}`;
  const bottomBorder = `${BOX.bottomLeft}${BOX.horizontal.repeat(Math.max(0, innerWidth))}${BOX.bottomRight}`;

  return [textLine, bottomBorder];
}

export function renderProjectSidebar(
  projects: ProjectGroup[],
  selectedIndex: number,
  height: number,
  width: number,
  isFocused: boolean,
): string[] {
  const lines: string[] = [];
  const visibleProjects = projects.slice(0, Math.max(0, height));

  for (let i = 0; i < visibleProjects.length; i++) {
    const project = visibleProjects[i]!;
    const isSelected = i === selectedIndex;

    let prefix = isSelected ? "▸ " : "  ";
    let name = project.displayName;
    if (project.isCurrentProject) {
      name = `${name} *`;
    }

    if (isSelected) {
      prefix = accent(prefix);
      name = isFocused ? theme.bold(accent(name)) : accent(name);
    } else {
      prefix = dim(prefix);
      name = dim(name);
    }

    const count = dim(`(${project.sessions.length})`);
    const baseLine = `${prefix}${name}`;
    const spaceCount = Math.max(
      0,
      width - visibleWidth(baseLine) - visibleWidth(count),
    );
    lines.push(padLine(baseLine + " ".repeat(spaceCount) + count, width));
  }

  while (lines.length < height) {
    lines.push(" ".repeat(width));
  }

  return lines;
}

export function renderSessionList(
  sessions: ResumeSessionEntry[],
  selectedIndex: number,
  scrollOffset: number,
  height: number,
  width: number,
  isFocused: boolean,
  showArchived: boolean,
): string[] {
  const visibleSessions = showArchived
    ? sessions
    : sessions.filter((session) => !session.isArchived);
  const maxVisible = Math.max(0, height);
  const lines: string[] = [];
  const start = Math.max(
    0,
    Math.min(scrollOffset, Math.max(0, visibleSessions.length - maxVisible)),
  );

  for (let i = 0; i < maxVisible; i++) {
    const session = visibleSessions[start + i];
    if (!session) {
      lines.push(" ".repeat(width));
      continue;
    }

    const absoluteIndex = start + i;
    const isSelected = absoluteIndex === selectedIndex;

    const prefix = isSelected ? accent("▸ ") : dim("  ");
    const archivedBadge = session.isArchived ? `${dim("[archived]")} ` : "";
    const worktreeBadge =
      session.worktreeGroup !== "main"
        ? `${accent("[wt]")} `
        : "";

    let title = session.displayTitle;
    if (isSelected && isFocused) {
      title = theme.bold(title);
    }

    const role = detectAgentMode(session.session);

    // Fixed-width columns for aligned metadata (pad raw text before colorizing)
    const timeRaw = session.timeAgo.padStart(8);
    const msgRaw = `${session.session.messageCount}m`.padStart(5);
    const roleRaw =
      role === "orchestrator" ? "orch"
        : role === "default" ? " def"
        : "   ?";

    const separator = dim(" · ");
    const rightSide = [
      colorizeTime(timeRaw, session.timeColor),
      dim(msgRaw),
      role === "orchestrator" ? warning(roleRaw)
        : role === "default" ? success(roleRaw)
        : dim(roleRaw),
    ].join(separator);

    const leftSide = `${prefix}${worktreeBadge}${archivedBadge}${title}`;
    const spaceCount = Math.max(
      0,
      width - visibleWidth(leftSide) - visibleWidth(rightSide),
    );
    const row = padLine(leftSide + " ".repeat(spaceCount) + rightSide, width);
    lines.push(isSelected && isFocused ? theme.bg("selectedBg", row) : row);
  }

  while (lines.length < height) {
    lines.push(" ".repeat(width));
  }

  return lines.slice(0, height);
}

export function renderDetailPanel(
  session: ResumeSessionEntry | undefined,
  height: number,
  width: number,
): string[] {
  const lines: string[] = [];

  if (!session) {
    const message = dim("No session selected");
    const topPad = Math.floor(height / 2);
    for (let i = 0; i < topPad; i++) {
      lines.push(" ".repeat(width));
    }
    const leftPad = Math.floor((width - visibleWidth(message)) / 2);
    lines.push(padLine(" ".repeat(Math.max(0, leftPad)) + message, width));
    while (lines.length < height) {
      lines.push(" ".repeat(width));
    }
    return lines;
  }

  const role = detectAgentMode(session.session);
  const roleText =
    role === "orchestrator"
      ? "Orchestrator"
      : role === "default"
        ? "Default"
        : "Unknown";

  const createdText = session.session.created.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const details = [
    { label: "Branch", value: session.session.branch ?? "main" },
    { label: "Role", value: roleText },
    { label: "Messages", value: String(session.session.messageCount) },
    { label: "Created", value: createdText },
    { label: "Modified", value: session.timeAgo },
    { label: "CWD", value: session.session.cwd || "(unknown)" },
    { label: "Worktree", value: session.worktreeGroup },
    { label: "Session", value: session.session.id },
  ];

  const labelColWidth = 10;
  const valueColWidth = Math.max(1, width - 2 - labelColWidth - 2);

  for (const detail of details) {
    const label = dim(padLine(detail.label, labelColWidth));
    const value = truncateToWidth(detail.value, valueColWidth);
    lines.push(padLine(`  ${label}  ${value}`, width));
  }

  while (lines.length < height) {
    lines.push(" ".repeat(width));
  }

  return lines.slice(0, height);
}

export function composePanels(
  leftLines: string[],
  centerLines: string[],
  rightLines: string[],
  spec: ModalColumnSpec,
  innerWidth: number,
): string[] {
  const height = Math.max(leftLines.length, centerLines.length, rightLines.length, 0);
  const lines: string[] = [];
  const targetRowWidth = innerWidth + 2;

  for (let i = 0; i < height; i++) {
    let row = `${BOX.vertical} `;

    if (spec.showSidebar) {
      row += (leftLines[i] ?? " ".repeat(spec.sidebarWidth)) + " ";
      row += `${BOX.vertical} `;
    }

    row += (centerLines[i] ?? " ".repeat(spec.listWidth)) + " ";

    if (spec.showDetail) {
      row += `${BOX.vertical} `;
      row += (rightLines[i] ?? " ".repeat(spec.detailWidth)) + " ";
    }

    row += BOX.vertical;
    lines.push(normalizeRowWidth(row, targetRowWidth));
  }

  return lines;
}
