import type { LucideIcon } from "lucide-react";
import { Activity, AlertCircle, BarChart3, Database, Download, Server, Star, Upload, Zap } from "lucide-react";
import type { AggregatedStats } from "../types";

interface StatsGridProps {
	stats: AggregatedStats;
}

interface StatConfig {
	key: string;
	title: string;
	icon: LucideIcon;
	color: string;
	getValue: (stats: AggregatedStats) => string;
	getDetail: (stats: AggregatedStats) => string;
	getSecondaryDetail?: (stats: AggregatedStats) => string | undefined;
}

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
	notation: "compact",
	maximumFractionDigits: 1,
});

function formatCompactNumber(value: number): string {
	return compactNumberFormatter.format(value);
}

function formatExactNumber(value: number): string {
	return value.toLocaleString();
}

function formatCost(value: number): string {
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

const totalPromptCompletionTokens = (stats: AggregatedStats) => stats.totalInputTokens + stats.totalOutputTokens;

const statConfig: StatConfig[] = [
	{
		key: "requests",
		title: "Total requests",
		icon: Server,
		color: "var(--accent-primary)",
		getValue: (s: AggregatedStats) => s.totalRequests.toLocaleString(),
		getDetail: (s: AggregatedStats) =>
			`${s.successfulRequests.toLocaleString()} success · ${s.failedRequests.toLocaleString()} errors`,
	},
	{
		key: "cost",
		title: "API-equivalent cost",
		icon: Activity,
		color: "var(--accent-primary)",
		getValue: (s: AggregatedStats) => formatCost(s.totalCost),
		getDetail: () => "API-equivalent from stored usage",
		getSecondaryDetail: (s: AggregatedStats) =>
			s.totalRequests > 0 ? `${formatCost(s.totalCost / s.totalRequests)} avg/req` : undefined,
	},
	{
		key: "premiumRequests",
		title: "Premium reqs",
		icon: Star,
		color: "var(--accent-amber)",
		getValue: (s: AggregatedStats) => formatExactNumber(s.totalPremiumRequests),
		getDetail: (s: AggregatedStats) =>
			s.totalRequests > 0 ? `${((s.totalPremiumRequests / s.totalRequests) * 100).toFixed(1)}% of requests` : "-",
	},
	{
		key: "cache",
		title: "Cache rate",
		icon: Database,
		color: "var(--accent-primary)",
		getValue: (s: AggregatedStats) => `${(s.cacheRate * 100).toFixed(1)}%`,
		getDetail: (s: AggregatedStats) => `${formatCompactNumber(s.totalCacheReadTokens)} cached tokens`,
	},
	{
		key: "inputTokens",
		title: "Input tokens",
		icon: Download,
		color: "var(--accent-primary)",
		getValue: (s: AggregatedStats) => formatExactNumber(s.totalInputTokens),
		getDetail: (s: AggregatedStats) =>
			totalPromptCompletionTokens(s) > 0
				? `${((s.totalInputTokens / totalPromptCompletionTokens(s)) * 100).toFixed(1)}% of prompt+completion`
				: "-",
	},
	{
		key: "outputTokens",
		title: "Output tokens",
		icon: Upload,
		color: "var(--accent-primary)",
		getValue: (s: AggregatedStats) => formatExactNumber(s.totalOutputTokens),
		getDetail: (s: AggregatedStats) =>
			totalPromptCompletionTokens(s) > 0
				? `${((s.totalOutputTokens / totalPromptCompletionTokens(s)) * 100).toFixed(1)}% of prompt+completion`
				: "-",
	},
	{
		key: "errors",
		title: "Error rate",
		icon: AlertCircle,
		color: "var(--accent-red)",
		getValue: (s: AggregatedStats) => `${(s.errorRate * 100).toFixed(1)}%`,
		getDetail: (s: AggregatedStats) => `${s.failedRequests.toLocaleString()} failed requests`,
	},
	{
		key: "tokens",
		title: "Tokens/sec",
		icon: BarChart3,
		color: "var(--accent-green)",
		getValue: (s: AggregatedStats) => s.avgTokensPerSecond?.toFixed(1) ?? "-",
		getDetail: (s: AggregatedStats) =>
			`${formatCompactNumber(totalPromptCompletionTokens(s))} total prompt+completion`,
	},
	{
		key: "ttft",
		title: "TTFT",
		icon: Zap,
		color: "var(--accent-amber)",
		getValue: (s: AggregatedStats) => (s.avgTtft ? `${(s.avgTtft / 1000).toFixed(2)}s` : "-"),
		getDetail: () => "Time to first token",
	},
];

export function StatsGrid({ stats }: StatsGridProps) {
	return (
		<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4 mb-8">
			{statConfig.map((stat, index) => {
				const Icon = stat.icon;
				return (
					<div key={stat.key} className={`stat-card group ${index < 2 ? "xl:col-span-2" : "xl:col-span-1"}`}>
						<div className="flex items-center justify-between mb-3">
							<span className="text-sm font-medium text-[var(--text-secondary)]">{stat.title}</span>
							<div
								className="p-2 rounded-[var(--radius-sm)] transition-colors"
								style={{ backgroundColor: `${stat.color}15` }}
							>
								<Icon
									size={18}
									strokeWidth={1.5}
									style={{ color: stat.color }}
									className="transition-transform group-hover:scale-110"
								/>
							</div>
						</div>
						<div className="metric-number text-2xl font-bold text-[var(--text-primary)] mb-1">
							{stat.getValue(stats)}
						</div>
						<div className="text-xs text-[var(--text-muted)] truncate">{stat.getDetail(stats)}</div>
						{stat.getSecondaryDetail ? (
							<div className="text-xs text-[var(--text-muted)] truncate">{stat.getSecondaryDetail(stats)}</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}
