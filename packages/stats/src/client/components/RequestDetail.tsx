import { Clock, Coins, FileJson, Gauge, Hash, Star, X, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRequestDetails } from "../api";
import type { RequestDetails } from "../types";

interface RequestDetailProps {
	id: number;
	onClose: () => void;
}

function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Unable to load request details.";
}

export function RequestDetail({ id, onClose }: RequestDetailProps) {
	const [details, setDetails] = useState<RequestDetails | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const previousFocusRef = useRef<HTMLElement | null>(null);

	const loadDetails = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		setDetails(null);
		try {
			setDetails(await getRequestDetails(id));
		} catch (err) {
			setLoadError(getErrorMessage(err));
		} finally {
			setLoading(false);
		}
	}, [id]);

	useEffect(() => {
		void loadDetails();
	}, [loadDetails]);

	useEffect(() => {
		previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogRef.current?.focus();

		return () => {
			previousFocusRef.current?.focus();
		};
	}, []);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	return (
		<div
			role="presentation"
			className="fixed inset-0 bg-[var(--bg-overlay)] backdrop-blur-sm flex justify-end animate-fade-in"
			onClick={onClose}
			style={{ zIndex: "var(--z-overlay)" }}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="request-detail-title"
				tabIndex={-1}
				className="w-[600px] max-w-full bg-[var(--bg-page)] h-full overflow-y-auto border-l border-[var(--border-subtle)] animate-slide-up outline-none"
				onClick={event => event.stopPropagation()}
				style={{ zIndex: "var(--z-modal)" }}
			>
				<div
					className="sticky top-0 bg-[var(--bg-page)]/95 backdrop-blur border-b border-[var(--border-subtle)] px-6 py-4 flex justify-between items-center"
					style={{ zIndex: "var(--z-modal)" }}
				>
					<div className="flex items-center gap-3">
						<div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[var(--bg-elevated)] border border-[var(--border-default)] flex items-center justify-center">
							<FileJson size={16} strokeWidth={1.5} className="text-[var(--accent-primary)]" />
						</div>
						<h2 id="request-detail-title" className="text-lg font-semibold text-[var(--text-primary)]">
							Request details
						</h2>
					</div>
					<button type="button" onClick={onClose} className="close-button" aria-label="Close request details">
						<X size={20} strokeWidth={1.5} />
					</button>
				</div>

				<div className="p-6 space-y-6">
					{loading ? (
						<div className="surface px-8 py-6">
							<div className="flex items-center gap-3 text-[var(--text-secondary)]">
								<div className="w-5 h-5 border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] rounded-full spin" />
								<span>Loading...</span>
							</div>
						</div>
					) : null}

					{loadError ? (
						<div className="inline-error" role="alert">
							<div>
								<h3 className="text-sm font-semibold text-[var(--text-primary)]">
									Request details unavailable
								</h3>
								<p className="mt-1 text-sm text-[var(--text-secondary)]">{loadError}</p>
							</div>
							<button type="button" className="btn btn-secondary" onClick={() => void loadDetails()}>
								Retry
							</button>
						</div>
					) : null}

					{details ? (
						<>
							<div className="surface p-5">
								<div className="flex items-center justify-between mb-4">
									<div>
										<div className="text-2xl font-bold text-[var(--text-primary)]">{details.model}</div>
										<div className="text-sm text-[var(--text-muted)]">{details.provider}</div>
									</div>
									{details.errorMessage ? (
										<span className="badge badge-error">Error</span>
									) : (
										<span className="badge badge-success">Success</span>
									)}
								</div>
							</div>

							<div className="grid grid-cols-2 gap-4">
								<div className="surface p-4">
									<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
										<Coins size={14} strokeWidth={1.5} />
										<span className="text-xs uppercase tracking-wide">Cost</span>
									</div>
									<div className="metric-number text-xl font-semibold text-[var(--text-primary)]">
										${details.usage.cost.total.toFixed(4)}
									</div>
								</div>

								<div className="surface p-4">
									<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
										<Star size={14} strokeWidth={1.5} />
										<span className="text-xs uppercase tracking-wide">Premium reqs</span>
									</div>
									<div className="metric-number text-xl font-semibold text-[var(--text-primary)]">
										{(details.usage.premiumRequests ?? 0).toLocaleString()}
									</div>
								</div>

								<div className="surface p-4">
									<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
										<Hash size={14} strokeWidth={1.5} />
										<span className="text-xs uppercase tracking-wide">Tokens</span>
									</div>
									<div className="metric-number text-xl font-semibold text-[var(--text-primary)]">
										{details.usage.totalTokens.toLocaleString()}
									</div>
									<div className="metric-number text-xs text-[var(--text-muted)] mt-1">
										{details.usage.input.toLocaleString()} in · {details.usage.output.toLocaleString()} out
									</div>
								</div>

								<div className="surface p-4">
									<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
										<Clock size={14} strokeWidth={1.5} />
										<span className="text-xs uppercase tracking-wide">Duration</span>
									</div>
									<div className="metric-number text-xl font-semibold text-[var(--text-primary)]">
										{details.duration ? `${(details.duration / 1000).toFixed(2)}s` : "-"}
									</div>
								</div>

								<div className="surface p-4">
									<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
										<Zap size={14} strokeWidth={1.5} />
										<span className="text-xs uppercase tracking-wide">TTFT</span>
									</div>
									<div className="metric-number text-xl font-semibold text-[var(--text-primary)]">
										{details.ttft ? `${(details.ttft / 1000).toFixed(2)}s` : "-"}
									</div>
								</div>
							</div>

							{details.duration && details.usage.output > 0 ? (
								<div className="surface p-4">
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-2 text-[var(--text-muted)]">
											<Gauge size={14} strokeWidth={1.5} />
											<span className="text-xs uppercase tracking-wide">Throughput</span>
										</div>
										<span className="metric-number text-2xl font-bold text-[var(--accent-primary)]">
											{((details.usage.output * 1000) / details.duration).toFixed(1)}
										</span>
									</div>
									<div className="text-xs text-[var(--text-muted)] mt-1 text-right">tokens/second</div>
								</div>
							) : null}

							<div>
								<h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Output</h3>
								<pre className="surface bg-[var(--bg-elevated)] p-4 rounded-[var(--radius-md)] text-sm font-mono text-[var(--text-secondary)] overflow-x-auto">
									{JSON.stringify(details.output, null, 2)}
								</pre>
							</div>

							<div>
								<h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Raw metadata</h3>
								<pre className="surface bg-[var(--bg-elevated)] p-4 rounded-[var(--radius-md)] text-xs font-mono text-[var(--text-muted)] overflow-x-auto">
									{JSON.stringify(details, null, 2)}
								</pre>
							</div>
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}
