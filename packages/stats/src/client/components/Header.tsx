import { Activity, RefreshCw } from "lucide-react";
import type { TimeRange } from "../types";

type Tab = "overview" | "requests" | "errors" | "models" | "costs" | "behavior";

const tabs: Tab[] = ["overview", "requests", "errors", "models", "costs", "behavior"];
const timeRanges: { label: string; value: TimeRange }[] = [
	{ label: "1h", value: "1h" },
	{ label: "24h", value: "24h" },
	{ label: "7d", value: "7d" },
	{ label: "30d", value: "30d" },
	{ label: "90d", value: "90d" },
	{ label: "All", value: "all" },
];

interface HeaderProps {
	activeTab: Tab;
	onTabChange: (tab: Tab) => void;
	onSync: () => void;
	syncing: boolean;
	timeRange: TimeRange;
	onTimeRangeChange: (timeRange: TimeRange) => void;
}

export function Header({ activeTab, onTabChange, onSync, syncing, timeRange, onTimeRangeChange }: HeaderProps) {
	return (
		<header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 mb-8 border-b border-[var(--border-subtle)]">
			<div className="flex items-center gap-3">
				<div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-default)] flex items-center justify-center">
					<Activity className="w-5 h-5 text-[var(--accent-primary)]" strokeWidth={1.5} />
				</div>
				<div>
					<h1 className="text-xl font-semibold text-[var(--text-primary)]">AI usage</h1>
					<p className="text-sm text-[var(--text-muted)]">Usage, cost, and session health</p>
				</div>
			</div>

			<div className="flex items-center gap-3">
				<nav aria-label="Dashboard sections">
					<div className="flex bg-[var(--bg-surface)] rounded-[var(--radius-md)] p-1 border border-[var(--border-subtle)]">
						{tabs.map(tab => (
							<button
								key={tab}
								type="button"
								onClick={() => onTabChange(tab)}
								className={`tab-btn capitalize ${activeTab === tab ? "active" : ""}`}
								aria-current={activeTab === tab ? "page" : undefined}
							>
								{tab}
							</button>
						))}
					</div>
				</nav>

				<div
					className="flex bg-[var(--bg-surface)] rounded-[var(--radius-md)] p-1 border border-[var(--border-subtle)]"
					role="group"
					aria-label="Time range"
				>
					{timeRanges.map(range => (
						<button
							key={range.value}
							type="button"
							onClick={() => onTimeRangeChange(range.value)}
							className={`tab-btn ${timeRange === range.value ? "active" : ""}`}
							title={range.value === "all" ? "All time" : `Last ${range.label}`}
							aria-pressed={timeRange === range.value}
						>
							{range.label}
						</button>
					))}
				</div>

				<button type="button" onClick={onSync} disabled={syncing} className="btn btn-primary">
					<RefreshCw size={16} className={syncing ? "spin" : ""} strokeWidth={1.5} />
					{syncing ? "Syncing..." : "Sync"}
				</button>
			</div>
		</header>
	);
}
