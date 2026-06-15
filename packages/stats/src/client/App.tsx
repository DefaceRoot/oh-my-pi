import { useCallback, useEffect, useRef, useState } from "react";
import {
	getBehaviorDashboardStats,
	getCostDashboardStats,
	getModelDashboardStats,
	getOverviewStats,
	getRecentErrors,
	getRecentRequests,
	sync,
} from "./api";
import { BehaviorChart } from "./components/BehaviorChart";
import { BehaviorModelsTable } from "./components/BehaviorModelsTable";
import { BehaviorSummary } from "./components/BehaviorSummary";
import { ChartsContainer } from "./components/ChartsContainer";
import { CostChart } from "./components/CostChart";
import { CostSummary } from "./components/CostSummary";
import { Header } from "./components/Header";
import { ModelsTable } from "./components/ModelsTable";
import { RequestDetail } from "./components/RequestDetail";
import { RequestList } from "./components/RequestList";
import { StatsGrid } from "./components/StatsGrid";
import type {
	BehaviorDashboardStats,
	CostDashboardStats,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	TimeRange,
} from "./types";

type Tab = "overview" | "requests" | "errors" | "models" | "costs" | "behavior";

export default function App() {
	const [overviewStats, setOverviewStats] = useState<OverviewStats | null>(null);
	const [modelStats, setModelStats] = useState<ModelDashboardStats | null>(null);
	const [costStats, setCostStats] = useState<CostDashboardStats | null>(null);
	const [behaviorStats, setBehaviorStats] = useState<BehaviorDashboardStats | null>(null);
	const [recentRequests, setRecentRequests] = useState<MessageStats[]>([]);
	const [recentErrors, setRecentErrors] = useState<MessageStats[]>([]);
	const [recentListsLoaded, setRecentListsLoaded] = useState(false);
	const [selectedRequest, setSelectedRequest] = useState<number | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<Tab>("overview");
	const [timeRange, setTimeRange] = useState<TimeRange>("24h");
	const syncInFlight = useRef<Promise<void> | null>(null);

	const loadRecentLists = useCallback(async () => {
		const [requests, errors] = await Promise.all([getRecentRequests(50), getRecentErrors(50)]);
		setRecentRequests(requests);
		setRecentErrors(errors);
		setRecentListsLoaded(true);
	}, []);

	const loadActiveTabStats = useCallback(async () => {
		if (activeTab === "models") {
			setModelStats(await getModelDashboardStats(timeRange));
			return;
		}
		if (activeTab === "costs") {
			setCostStats(await getCostDashboardStats(timeRange));
			return;
		}
		if (activeTab === "behavior") {
			setBehaviorStats(await getBehaviorDashboardStats(timeRange));
			return;
		}
		if (activeTab === "overview") {
			setOverviewStats(await getOverviewStats(timeRange));
		}
	}, [activeTab, timeRange]);

	const runSync = useCallback(async () => {
		if (syncInFlight.current) return syncInFlight.current;

		setSyncing(true);
		syncInFlight.current = sync()
			.then(() => undefined)
			.finally(() => {
				syncInFlight.current = null;
				setSyncing(false);
			});
		return syncInFlight.current;
	}, []);

	const refreshStats = useCallback(
		async ({ runSync: shouldSync }: { runSync: boolean }) => {
			try {
				setLoadError(null);
				if (shouldSync) await runSync();
				await Promise.all([loadActiveTabStats(), loadRecentLists()]);
			} catch (error) {
				setLoadError(error instanceof Error ? error.message : "Failed to refresh stats");
			}
		},
		[loadActiveTabStats, loadRecentLists, runSync],
	);

	const handleSync = () => {
		void refreshStats({ runSync: true });
	};

	useEffect(() => {
		void refreshStats({ runSync: true });
		const interval = setInterval(() => {
			void refreshStats({ runSync: true });
		}, 30000);
		return () => clearInterval(interval);
	}, [refreshStats]);

	return (
		<div className="min-h-[100dvh]">
			<a href="#stats-main" className="skip-link">
				Skip to stats content
			</a>
			<main id="stats-main" className="max-w-[1600px] mx-auto px-6 py-6">
				<Header
					activeTab={activeTab}
					onTabChange={setActiveTab}
					onSync={handleSync}
					syncing={syncing}
					timeRange={timeRange}
					onTimeRangeChange={setTimeRange}
				/>

				{loadError && <RefreshErrorBanner message={loadError} onRetry={() => refreshStats({ runSync: true })} />}

				{activeTab === "overview" && (
					<div className="space-y-6 animate-fade-in">
						{overviewStats ? <StatsGrid stats={overviewStats.overall} /> : <DashboardSkeleton kind="overview" />}

						{recentListsLoaded ? (
							<div className="grid lg:grid-cols-2 gap-6">
								<RequestList
									title="Recent Requests"
									requests={recentRequests.slice(0, 10)}
									onSelect={r => r.id && setSelectedRequest(r.id)}
								/>
								<RequestList
									title="Recent Errors"
									requests={recentErrors.slice(0, 10)}
									onSelect={r => r.id && setSelectedRequest(r.id)}
								/>
							</div>
						) : (
							<div className="grid lg:grid-cols-2 gap-6">
								<DashboardSkeleton kind="table" />
								<DashboardSkeleton kind="table" />
							</div>
						)}
					</div>
				)}

				{activeTab === "requests" && (
					<div className="h-[calc(100dvh-140px)] animate-fade-in">
						{recentListsLoaded ? (
							<RequestList
								title="All Recent Requests"
								requests={recentRequests}
								onSelect={r => r.id && setSelectedRequest(r.id)}
							/>
						) : (
							<DashboardSkeleton kind="table" />
						)}
					</div>
				)}

				{activeTab === "errors" && (
					<div className="h-[calc(100dvh-140px)] animate-fade-in">
						{recentListsLoaded ? (
							<RequestList
								title="Failed Requests"
								requests={recentErrors}
								onSelect={r => r.id && setSelectedRequest(r.id)}
							/>
						) : (
							<DashboardSkeleton kind="table" />
						)}
					</div>
				)}

				{activeTab === "models" && (
					<div className="space-y-6 animate-fade-in">
						{modelStats ? (
							<>
								<ChartsContainer modelSeries={modelStats.modelSeries} timeRange={timeRange} />
								<ModelsTable
									models={modelStats.byModel}
									performanceSeries={modelStats.modelPerformanceSeries}
									timeRange={timeRange}
								/>
							</>
						) : (
							<DashboardSkeleton kind="charts" />
						)}
					</div>
				)}

				{activeTab === "costs" && (
					<div className="space-y-6 animate-fade-in">
						{costStats ? (
							<>
								<CostSummary costSeries={costStats.costSeries} />
								<CostChart costSeries={costStats.costSeries} />
							</>
						) : (
							<DashboardSkeleton kind="charts" />
						)}
					</div>
				)}

				{activeTab === "behavior" && (
					<div className="space-y-6 animate-fade-in">
						{behaviorStats ? (
							<>
								<BehaviorSummary
									overall={behaviorStats.overall}
									behaviorSeries={behaviorStats.behaviorSeries}
								/>
								<BehaviorChart behaviorSeries={behaviorStats.behaviorSeries} />
								<BehaviorModelsTable
									models={behaviorStats.byModel}
									behaviorSeries={behaviorStats.behaviorSeries}
								/>
							</>
						) : (
							<DashboardSkeleton kind="charts" />
						)}
					</div>
				)}

				{selectedRequest !== null && (
					<RequestDetail id={selectedRequest} onClose={() => setSelectedRequest(null)} />
				)}
			</main>
		</div>
	);
}

function RefreshErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
	return (
		<div className="inline-error mb-6" role="alert">
			<div>
				<p className="font-semibold text-[var(--text-primary)]">Stats refresh failed</p>
				<p className="text-sm text-[var(--text-secondary)]">{message}</p>
			</div>
			<button type="button" className="btn btn-secondary" onClick={onRetry}>
				Retry
			</button>
		</div>
	);
}

function DashboardSkeleton({ kind }: { kind: "overview" | "table" | "charts" }) {
	if (kind === "overview") {
		return (
			<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4 mb-8" aria-hidden="true">
				{Array.from({ length: 9 }, (_, index) => (
					<div key={index} className={`stat-card ${index < 2 ? "xl:col-span-2" : "xl:col-span-1"}`}>
						<div className="skeleton h-[14px] w-28 mb-4" />
						<div className="skeleton h-8 w-36 mb-3" />
						<div className="skeleton h-3 w-24" />
					</div>
				))}
			</div>
		);
	}

	if (kind === "table") {
		return (
			<div className="surface p-5 h-full" aria-hidden="true">
				<div className="skeleton h-4 w-40 mb-5" />
				{Array.from({ length: 8 }, (_, index) => (
					<div key={index} className="grid grid-cols-6 gap-4 py-3 border-t border-[var(--border-subtle)]">
						<div className="skeleton h-4 col-span-2" />
						<div className="skeleton h-4" />
						<div className="skeleton h-4" />
						<div className="skeleton h-4" />
						<div className="skeleton h-4" />
					</div>
				))}
			</div>
		);
	}

	return (
		<div className="space-y-6" aria-hidden="true">
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				{Array.from({ length: 3 }, (_, index) => (
					<div key={index} className="surface px-4 py-3">
						<div className="skeleton h-3 w-24 mb-3" />
						<div className="skeleton h-6 w-32" />
					</div>
				))}
			</div>
			<div className="grid lg:grid-cols-2 gap-6">
				<div className="surface p-5">
					<div className="skeleton h-[260px]" />
				</div>
				<div className="surface p-5">
					<div className="skeleton h-[260px]" />
				</div>
			</div>
		</div>
	);
}
