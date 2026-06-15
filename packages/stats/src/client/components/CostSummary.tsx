import type { CostTimeSeriesPoint } from "../types";

interface CostSummaryProps {
	costSeries: CostTimeSeriesPoint[];
}

function formatCost(value: number): string {
	if (value < 0.01) return `$${value.toFixed(4)}`;
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

export function CostSummary({ costSeries }: CostSummaryProps) {
	const totalCost = costSeries.reduce((sum, p) => sum + p.cost, 0);
	const dayBuckets = new Set(costSeries.map(p => p.timestamp)).size;
	const avgDaily = dayBuckets > 0 ? totalCost / dayBuckets : 0;

	// Most expensive model over the visible window
	const modelTotals = new Map<string, number>();
	for (const point of costSeries) {
		modelTotals.set(point.model, (modelTotals.get(point.model) ?? 0) + point.cost);
	}
	let topModel = "";
	let topModelCost = 0;
	for (const [model, cost] of modelTotals) {
		if (cost > topModelCost) {
			topModel = model;
			topModelCost = cost;
		}
	}

	const cards = [
		{ label: "API-equivalent total", value: formatCost(totalCost), numeric: true },
		{ label: "Average per day", value: formatCost(avgDaily), numeric: true },
		{
			label: "Top model",
			value: topModel || "—",
			sub: topModel ? formatCost(topModelCost) : undefined,
			numeric: false,
		},
	];

	return (
		<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
			{cards.map(card => (
				<div key={card.label} className="surface px-4 py-3">
					<p className="text-xs text-[var(--text-muted)] mb-1">{card.label}</p>
					<p
						className={`text-lg font-semibold text-[var(--text-primary)] truncate ${card.numeric ? "metric-number" : ""}`}
						title={card.value}
					>
						{card.value}
					</p>
					{card.sub && <p className="text-xs text-[var(--text-muted)] mt-0.5 metric-number">{card.sub}</p>}
				</div>
			))}
		</div>
	);
}
