<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		createBeancountDB,
		type BeancountDB,
		type CashFlowLink,
		type NetWorthPoint,
		type TransactionRow
	} from '$lib/beancount-db';
	import Chart from 'chart.js/auto';
	import 'chartjs-adapter-date-fns';
	import { SankeyController, Flow } from 'chartjs-chart-sankey';
	import {
		loadPresets,
		upsertPreset,
		deletePreset,
		makeId,
		saveLoadedData,
		loadStoredData,
		type DashboardPreset,
		type ChartView,
		type StoredFile
	} from '$lib/presets';

	Chart.register(SankeyController, Flow);

	let beancountDB: BeancountDB | null = null;
	let accounts: string[] = [];
	let postingAccounts: string[] = [];
	$: postingSet = new Set(postingAccounts);
	let isLoading = true;
	let error: string | null = null;
	let chart: Chart | null = null;

	let view: ChartView = 'trends';

	// Trends controls
	let selectedAccount = '';
	let includeDescendants = false;
	let startDate = '';
	let endDate = '';
	let windowSize = 30;
	let showBalance = true;
	let showDailyRate = true;
	let useEMA = true;
	let runningAverageData: { date: string; balance: number; runningAverage: number }[] = [];

	// Drag-to-select range on the Trends chart → list transactions in that range.
	let selPxStart: number | null = null;
	let selPxEnd: number | null = null;
	let selDragging = false;
	let selRange: { start: string; end: string } | null = null;
	let selLabel = '';
	let selShowAccount = false;
	let selectedTransactions: TransactionRow[] = [];
	let txSort: 'amount' | 'date' = 'amount';
	$: sortedTransactions = [...selectedTransactions].sort((a, b) =>
		txSort === 'amount'
			? Math.abs(b.amount) - Math.abs(a.amount)
			: a.date.localeCompare(b.date) || Math.abs(b.amount) - Math.abs(a.amount)
	);
	$: selTotal = selectedTransactions.reduce((s, t) => s + t.amount, 0);

	// Cash-flow controls (hierarchical breakdown of one account tree)
	let flowRoot = '';
	let flowMaxDepth = 2;
	let flowMinAmount = 0;
	let cashFlow: CashFlowLink[] = [];
	let cashFlowTotal = 0;
	let topRoots: string[] = [];

	// Monthly breakdown: stacked bars of a group account's direct children.
	let monthlyRoot = '';
	let monthlyTopN = 6;
	let monthlyStats = { total: 0, avg: 0, months: 0, top: '' };

	// Income vs expenses per month.
	let incomeRoot = '';
	let expenseRoot = '';
	let incomeStats = { income: 0, expenses: 0, net: 0, rate: null as number | null };

	// Net worth = assets + liabilities (liabilities carry negative balances).
	let assetRoots: string[] = [];
	let liabilityRoots: string[] = [];
	let netWorthData: NetWorthPoint[] = [];

	// Calendar heatmap of daily totals for the selected account.
	type HeatCell = { date: string; x: number; y: number; amount: number | null; color: string };
	type HeatYear = { year: number; width: number; cells: HeatCell[]; months: { label: string; x: number }[] };
	let heatYears: HeatYear[] = [];
	let heatLegend: string[] = [];
	let heatStats = { total: 0, activeDays: 0, perDay: 0, maxDate: '', max: 0 };
	let heatHover: HeatCell | null = null;
	let heatFlip = 1;

	let dataFiles: StoredFile[] = [];
	let dataRange: { start: string; end: string } | null = null;

	// Zoom / pan viewport
	let viewport: HTMLDivElement;
	let zoom = 1;
	const ZOOM_MIN = 1;
	const ZOOM_MAX = 6;

	// Presets
	let presets: DashboardPreset[] = [];
	let presetName = '';

	// Compare / diff against an earlier (or later) period of the SAME width.
	// Define a baseline by its start date only; the end is derived to match the
	// current range width. Shift it with the steppers to line periods up.
	let compareEnabled = false;
	let compareStart = '';
	$: rangeDays =
		startDate && endDate
			? Math.round((parseLocal(endDate).getTime() - parseLocal(startDate).getTime()) / 86400000)
			: 0;
	$: compareEnd = compareStart ? fmtDate(addDays(parseLocal(compareStart), rangeDays)) : '';
	$: compareRange =
		compareEnabled && compareStart && compareEnd
			? { startDate: compareStart, endDate: compareEnd }
			: null;

	const palette = [
		'#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed',
		'#0891b2', '#db2777', '#65a30d', '#ca8a04', '#4f46e5'
	];

	// Categorical series colors for the bar/line views, assigned in fixed order.
	// Anything past the last slot folds into a gray "Other".
	const series = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
	const otherColor = '#a8a7a2';
	const inkColor = '#374151';
	// Sequential (magnitude) and opposite-sign ramps for the heatmap.
	const heatRamp = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];
	const heatNegRamp = ['#f6c9c8', '#ee9392', '#e34948'];
	const heatEmpty = '#ebeae6';

	const tabs: { id: ChartView; label: string }[] = [
		{ id: 'trends', label: 'Balance & Trends' },
		{ id: 'cashflow', label: 'Cash Flow (Hierarchy)' },
		{ id: 'monthly', label: 'Monthly by Category' },
		{ id: 'income', label: 'Income vs Expenses' },
		{ id: 'networth', label: 'Net Worth' },
		{ id: 'heatmap', label: 'Calendar' }
	];
	$: supportsCompare = view === 'trends' || view === 'cashflow';

	const eur = (v: number) =>
		`${v < 0 ? '−' : ''}€${Math.abs(v).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

	function nodeColor(id: string): string {
		const root = id.split(':')[0];
		let hash = 0;
		for (let i = 0; i < root.length; i++) hash = (hash * 31 + root.charCodeAt(i)) >>> 0;
		return palette[hash % palette.length];
	}

	function deriveRoots(list: string[]): string[] {
		return [...new Set(list.map((a) => a.split(':')[0]))].sort();
	}

	// Expand a list of posting accounts into the full tree, adding every ancestor
	// prefix (e.g. Uitgaven:Eten:Frietjes also yields Uitgaven and Uitgaven:Eten)
	// so parent/group accounts are selectable even without direct postings.
	function expandWithParents(list: string[]): string[] {
		const set = new Set<string>();
		for (const acc of list) {
			const segs = acc.split(':');
			for (let i = 1; i <= segs.length; i++) set.add(segs.slice(0, i).join(':'));
		}
		return [...set].sort();
	}

	// A "group" account has no postings of its own — only sub-accounts.
	const isGroupAccount = (account: string) => !postingSet.has(account);

	// Carry-forward sampler: value of the last point at or before time t (0 before).
	function makeSampler(points: { ms: number; value: number }[]): (t: number) => number {
		return (t: number) => {
			let v = 0;
			for (const p of points) {
				if (p.ms <= t) v = p.value;
				else break;
			}
			return v;
		};
	}

	// Parse an ISO date as local midnight (avoids UTC/local drift in comparisons).
	function parseLocal(date: string): Date {
		const [y, m, d] = date.split('-').map(Number);
		return new Date(y, m - 1, d);
	}

	// Add a number of days using local calendar arithmetic (DST-safe).
	function addDays(d: Date, days: number): Date {
		return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
	}

	onMount(async () => {
		try {
			let beancountData: StoredFile[] | null = null;

			const sessionStr = sessionStorage.getItem('beancountData');
			if (sessionStr) {
				beancountData = JSON.parse(sessionStr);
				if (beancountData) saveLoadedData(beancountData);
			} else {
				beancountData = loadStoredData();
			}

			if (!beancountData || beancountData.length === 0) {
				error = 'No beancount data found. Please go back and import files.';
				isLoading = false;
				return;
			}

			dataFiles = beancountData;
			beancountDB = await createBeancountDB();
			await beancountDB.loadBeancountData(beancountData);
			postingAccounts = await beancountDB.getAllAccounts();
			accounts = expandWithParents(postingAccounts);
			dataRange = await beancountDB.getDateRange();

			if (accounts.length === 0) {
				error = 'No accounts found in the beancount files. Check the file format and content.';
				isLoading = false;
				return;
			}

			presets = loadPresets();

			topRoots = deriveRoots(accounts);
			flowRoot = topRoots.find((r) => /uitgave|expense/i.test(r)) || topRoots[0] || '';
			applyRootDefaults();

			selectedAccount = accounts[0];
			if (dataRange) {
				startDate = dataRange.start;
				endDate = dataRange.end;
			}
			await refresh();
		} catch (err) {
			console.error('Error initializing dashboard:', err);
			error = err instanceof Error ? err.message : 'Failed to initialize dashboard';
		} finally {
			isLoading = false;
		}
	});

	// Guess the conventional roots (English or Dutch naming) when unset/stale.
	function applyRootDefaults() {
		const find = (re: RegExp) => topRoots.find((r) => re.test(r)) || '';
		if (!accounts.includes(monthlyRoot)) monthlyRoot = flowRoot;
		if (!topRoots.includes(expenseRoot)) expenseRoot = find(/uitgave|expense/i);
		if (!topRoots.includes(incomeRoot)) incomeRoot = find(/inkomst|income|opbrengst|revenue/i);
		assetRoots = assetRoots.filter((r) => topRoots.includes(r));
		liabilityRoots = liabilityRoots.filter((r) => topRoots.includes(r));
		if (assetRoots.length === 0) assetRoots = topRoots.filter((r) => /^(assets?|activa|bezit)/i.test(r));
		if (liabilityRoots.length === 0) liabilityRoots = topRoots.filter((r) => /^(liabilit|passiva|schuld)/i.test(r));
	}

	async function refresh() {
		if (!beancountDB) return;
		error = null;
		clearSelection();
		if (view === 'heatmap') {
			chart?.destroy();
			chart = null;
			await renderHeatmap();
			return;
		}
		// The canvas only exists outside the calendar view; let the DOM catch up.
		await tick();
		if (view === 'trends') await renderTrends();
		else if (view === 'cashflow') await renderCashFlow();
		else if (view === 'monthly') await renderMonthly();
		else if (view === 'income') await renderIncome();
		else if (view === 'networth') await renderNetWorth();
	}

	async function setView(v: ChartView) {
		view = v;
		await refresh();
	}

	async function showTransactions(label: string, account: string, withDescendants: boolean, start: string, end: string) {
		if (!beancountDB) return;
		selRange = { start, end };
		selLabel = label;
		selShowAccount = withDescendants;
		selectedTransactions = await beancountDB.getTransactions(account, withDescendants, start, end);
	}

	async function handleRangeSelected(msMin: number | null, msMax: number | null) {
		if (msMin == null || msMax == null) {
			clearSelection();
			return;
		}
		const s = fmtDate(new Date(msMin));
		const e = fmtDate(new Date(msMax));
		await showTransactions(selectedAccount, selectedAccount, includeDescendants, s, e);
	}

	function clearSelection() {
		selPxStart = null;
		selPxEnd = null;
		selDragging = false;
		selRange = null;
		selectedTransactions = [];
		if (view === 'trends') chart?.draw();
	}

	// Chart.js plugin: drag across the plot to highlight a date range, then emit it.
	const rangeSelectPlugin = {
		id: 'rangeSelect',
		afterEvent(chart: any, args: any) {
			const e = args.event;
			const area = chart.chartArea;
			const clamp = (x: number) => Math.min(Math.max(x, area.left), area.right);
			if (e.type === 'mousedown') {
				selDragging = true;
				selPxStart = clamp(e.x);
				selPxEnd = selPxStart;
				args.changed = true;
			} else if (e.type === 'mousemove' && selDragging) {
				selPxEnd = clamp(e.x);
				args.changed = true;
			} else if ((e.type === 'mouseup' || e.type === 'mouseout') && selDragging) {
				selDragging = false;
				if (selPxStart != null && selPxEnd != null && Math.abs(selPxEnd - selPxStart) > 4) {
					const a = chart.scales.x.getValueForPixel(Math.min(selPxStart, selPxEnd));
					const b = chart.scales.x.getValueForPixel(Math.max(selPxStart, selPxEnd));
					handleRangeSelected(a, b);
				} else {
					handleRangeSelected(null, null);
				}
				args.changed = true;
			}
		},
		afterDraw(chart: any) {
			if (selPxStart == null || selPxEnd == null) return;
			const { ctx, chartArea: area } = chart;
			const left = Math.min(selPxStart, selPxEnd);
			const right = Math.max(selPxStart, selPxEnd);
			ctx.save();
			ctx.fillStyle = 'rgba(37, 99, 235, 0.12)';
			ctx.fillRect(left, area.top, right - left, area.bottom - area.top);
			ctx.strokeStyle = 'rgba(37, 99, 235, 0.6)';
			ctx.lineWidth = 1;
			ctx.strokeRect(left, area.top, right - left, area.bottom - area.top);
			ctx.restore();
		}
	};

	async function renderTrends() {
		if (!beancountDB || !selectedAccount) return;
		// A re-render invalidates pixel selections (axis may change).
		selPxStart = null;
		selPxEnd = null;
		selDragging = false;
		selRange = null;
		selectedTransactions = [];
		runningAverageData = await beancountDB.getRunningAverage(
			selectedAccount, includeDescendants, windowSize, startDate, endDate, showDailyRate, useEMA
		);

		const ctx = document.getElementById('chart') as HTMLCanvasElement;
		if (!ctx) return;
		if (chart) chart.destroy();

		if (runningAverageData.length === 0) {
			error = `No data found for account "${selectedAccount}" in this range.`;
			return;
		}

		const datasets: any[] = [];
		const rateLabel = showDailyRate ? 'Daily rate' : `Per ${windowSize} days`;
		let titleText = `${selectedAccount}${includeDescendants ? ' (incl. sub-accounts)' : ''}`;
		let yTitle = showBalance ? 'Balance (EUR)' : 'Amount (EUR)';
		let y1Title = 'Flow rate (EUR)';

		if (compareRange) {
			// Diff mode: plot (current − baseline) so an identical period is flat at 0.
			const cmp = await beancountDB.getRunningAverage(
				selectedAccount, includeDescendants, windowSize,
				compareRange.startDate, compareRange.endDate, showDailyRate, useEMA
			);
			// Align the baseline onto the current timeframe by whole calendar months
			// (so Jan→Jan year-over-year, robust to leap years / month lengths).
			const cs = parseLocal(startDate || runningAverageData[0].date);
			const bs = parseLocal(compareRange.startDate || cmp[0]?.date || startDate);
			const monthsShift = (cs.getFullYear() - bs.getFullYear()) * 12 + (cs.getMonth() - bs.getMonth());
			const shiftMs = (date: string) => {
				const d = parseLocal(date);
				return new Date(d.getFullYear(), d.getMonth() + monthsShift, d.getDate()).getTime();
			};

			const curBal = makeSampler(runningAverageData.map((d) => ({ ms: parseLocal(d.date).getTime(), value: d.balance })));
			const curRate = makeSampler(runningAverageData.map((d) => ({ ms: parseLocal(d.date).getTime(), value: d.runningAverage })));
			const baseBal = makeSampler(cmp.map((d) => ({ ms: shiftMs(d.date), value: d.balance })));
			const baseRate = makeSampler(cmp.map((d) => ({ ms: shiftMs(d.date), value: d.runningAverage })));

			// Union of sample points: current dates + baseline dates shifted onto the
			// current timeframe. Both samplers now live in the same calendar space.
			const xsMs = new Set<number>();
			for (const d of runningAverageData) xsMs.add(parseLocal(d.date).getTime());
			for (const d of cmp) xsMs.add(shiftMs(d.date));
			const xs = [...xsMs].sort((a, b) => a - b);

			if (showBalance) {
				datasets.push({
					label: 'Δ Balance',
					data: xs.map((x) => ({ x, y: curBal(x) - baseBal(x) })),
					borderColor: '#2563eb',
					backgroundColor: 'rgba(37, 99, 235, 0.12)',
					borderWidth: 2,
					pointRadius: 0,
					stepped: true,
					fill: true,
					yAxisID: 'y'
				});
			}
			datasets.push({
				label: `Δ ${rateLabel}`,
				data: xs.map((x) => ({ x, y: curRate(x) - baseRate(x) })),
				borderColor: '#dc2626',
				backgroundColor: 'rgba(220, 38, 38, 0.12)',
				borderWidth: 2,
				pointRadius: 0,
				tension: 0.25,
				fill: false,
				yAxisID: showBalance ? 'y1' : 'y'
			});

			titleText = `${selectedAccount} — change vs ${compareRange.startDate} → ${compareRange.endDate}`;
			yTitle = 'Δ Balance (EUR)';
			y1Title = 'Δ Flow rate (EUR)';
		} else {
			if (showBalance) {
				datasets.push({
					label: 'Balance',
					data: runningAverageData.map((d) => ({ x: d.date, y: d.balance })),
					borderColor: '#2563eb',
					backgroundColor: 'rgba(37, 99, 235, 0.12)',
					borderWidth: 2,
					pointRadius: 0,
					stepped: true,
					fill: true,
					yAxisID: 'y'
				});
			}
			datasets.push({
				label: `${rateLabel} (${useEMA ? 'EMA' : 'SMA'} ${windowSize}d)`,
				data: runningAverageData.map((d) => ({ x: d.date, y: d.runningAverage })),
				borderColor: '#dc2626',
				backgroundColor: 'rgba(220, 38, 38, 0.12)',
				borderWidth: 2,
				pointRadius: 0,
				tension: 0.25,
				fill: false,
				yAxisID: showBalance ? 'y1' : 'y'
			});
		}

		chart = new Chart(ctx, {
			type: 'line',
			data: { datasets },
			plugins: [rangeSelectPlugin],
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				events: ['mousedown', 'mousemove', 'mouseup', 'mouseout', 'click', 'touchstart', 'touchmove', 'touchend'],
				interaction: { mode: 'index', intersect: false },
				scales: {
					x: {
						type: 'time',
						time: { unit: 'month', tooltipFormat: 'yyyy-MM-dd' },
						grid: { display: false },
						title: { display: true, text: 'Date' }
					},
					y: {
						position: 'left',
						title: { display: true, text: yTitle },
						grid: {
							color: (c: any) =>
								compareRange && c.tick?.value === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.05)',
							lineWidth: (c: any) => (compareRange && c.tick?.value === 0 ? 1.5 : 1)
						}
					},
					...(showBalance
						? {
								y1: {
									position: 'right',
									title: { display: true, text: y1Title },
									grid: { drawOnChartArea: false }
								}
							}
						: {})
				},
				plugins: {
					title: {
						display: true,
						text: titleText
					},
					legend: { position: 'top' },
					tooltip: { callbacks: { label: (c: any) => `${c.dataset.label}: €${Number(c.parsed.y).toFixed(2)}` } }
				}
			} as any
		});
	}

	async function renderCashFlow() {
		if (!beancountDB) return;
		const result = await beancountDB.getCashFlow({
			root: flowRoot,
			maxDepth: flowMaxDepth,
			minAmount: flowMinAmount,
			startDate,
			endDate
		});
		cashFlow = result.links;
		cashFlowTotal = result.total;

		const ctx = document.getElementById('chart') as HTMLCanvasElement;
		if (!ctx) return;
		if (chart) chart.destroy();

		if (cashFlow.length === 0) {
			error = `No sub-accounts found under "${flowRoot}" in this range. Try another account or lower the minimum amount.`;
			return;
		}

		const labels: Record<string, string> = {};
		const colors: Record<string, string> = {};
		const columns: Record<string, number> = {};
		for (const n of result.nodes) {
			labels[n.id] = n.label;
			colors[n.id] = nodeColor(n.id);
			columns[n.id] = n.column;
		}

		// Diff mode: width = magnitude of change vs the baseline period, colored by
		// direction. Uses the CURRENT root/depth over the baseline date range.
		if (compareRange) {
			const base = await beancountDB.getCashFlow({
				root: flowRoot,
				maxDepth: flowMaxDepth,
				minAmount: 0,
				startDate: compareRange.startDate,
				endDate: compareRange.endDate
			});
			const key = (l: CashFlowLink) => `${l.from}\u0000${l.to}`;
			const baseMap = new Map(base.links.map((l) => [key(l), l.flow]));
			const curMap = new Map(result.links.map((l) => [key(l), l.flow]));
			for (const n of base.nodes) {
				if (!(n.id in columns)) {
					labels[n.id] = n.label;
					colors[n.id] = nodeColor(n.id);
					columns[n.id] = n.column;
				}
			}

			const diffData: { from: string; to: string; flow: number; cur: number; base: number; delta: number }[] = [];
			for (const k of new Set([...curMap.keys(), ...baseMap.keys()])) {
				const cur = curMap.get(k) ?? 0;
				const baseVal = baseMap.get(k) ?? 0;
				const delta = Math.round((cur - baseVal) * 100) / 100;
				if (Math.abs(delta) < Math.max(flowMinAmount, 0.01)) continue;
				const [from, to] = k.split('\u0000');
				diffData.push({ from, to, flow: Math.abs(delta), cur, base: baseVal, delta });
			}
			diffData.sort((a, b) => b.flow - a.flow);

			if (diffData.length === 0) {
				chart = null;
				error = `No differences vs ${compareRange.startDate} → ${compareRange.endDate} for ${flowRoot} in this range.`;
				return;
			}

			const up = '#dc2626';
			const down = '#16a34a';
			const edgeColor = (c: any) => (c.dataset.data[c.dataIndex].delta >= 0 ? up : down);

			chart = new Chart(ctx, {
				type: 'sankey' as any,
				data: {
					datasets: [
						{
							label: 'Change vs baseline',
							data: diffData,
							colorFrom: edgeColor,
							colorTo: edgeColor,
							colorMode: 'gradient',
							labels,
							column: columns,
							size: 'max'
						} as any
					]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					animation: false,
					layout: { padding: { right: 12, left: 4, top: 8, bottom: 8 } },
					plugins: {
						title: { display: true, text: `${flowRoot} — change vs ${compareRange.startDate} → ${compareRange.endDate}` },
						tooltip: {
							callbacks: {
								label: (c: any) => {
									const d = c.dataset.data[c.dataIndex];
									const sign = d.delta >= 0 ? '+' : '−';
									return [
										`${d.from} → ${d.to}`,
										`Now €${d.cur.toFixed(2)} · Was €${d.base.toFixed(2)}`,
										`Change ${sign}€${Math.abs(d.delta).toFixed(2)}`
									];
								}
							}
						}
					}
				} as any
			});
			return;
		}

		chart = new Chart(ctx, {
			type: 'sankey' as any,
			data: {
				datasets: [
					{
						label: 'Account flow',
						data: cashFlow.map((l) => ({ from: l.from, to: l.to, flow: l.flow })),
						colorFrom: (c: any) => colors[c.dataset.data[c.dataIndex].from] || '#94a3b8',
						colorTo: (c: any) => colors[c.dataset.data[c.dataIndex].to] || '#94a3b8',
						colorMode: 'gradient',
						labels,
						column: columns,
						size: 'max'
					} as any
				]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				layout: { padding: { right: 12, left: 4, top: 8, bottom: 8 } },
				plugins: {
					title: { display: true, text: `${flowRoot} — flow by sub-account` },
					tooltip: {
						callbacks: {
							label: (c: any) => {
								const d = c.dataset.data[c.dataIndex];
								return `${d.from} → ${d.to}: €${Number(d.flow).toFixed(2)}`;
							}
						}
					}
				}
			} as any
		});
	}

	// Every YYYY-MM between two dates (inclusive), so empty months still show.
	function monthsBetween(first: string, last: string): string[] {
		const out: string[] = [];
		let [y, m] = first.slice(0, 7).split('-').map(Number);
		const [ly, lm] = last.slice(0, 7).split('-').map(Number);
		while (y < ly || (y === ly && m <= lm)) {
			out.push(`${y}-${String(m).padStart(2, '0')}`);
			if (++m > 12) {
				m = 1;
				y++;
			}
		}
		return out;
	}

	const monthLabel = (ym: string) => {
		const [y, m] = ym.split('-').map(Number);
		return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
	};

	function monthBounds(ym: string): { start: string; end: string } {
		const [y, m] = ym.split('-').map(Number);
		return { start: fmtDate(new Date(y, m - 1, 1)), end: fmtDate(new Date(y, m, 0)) };
	}

	// Month axis for the selected range, falling back to the months with data.
	function monthAxis(dataMonths: string[]): string[] {
		const first = startDate || dataMonths[0];
		const last = endDate || dataMonths[dataMonths.length - 1];
		return first && last ? monthsBetween(first, last) : [];
	}

	// Map an account onto the direct child of `root` it belongs to.
	function childOf(root: string, account: string): string {
		if (account === root) return root;
		const depth = root.split(':').length;
		return account.split(':').slice(0, depth + 1).join(':');
	}

	const barOptions = (title: string, stacked: boolean, onClick?: (el: any) => void): any => ({
		responsive: true,
		maintainAspectRatio: false,
		animation: false,
		interaction: { mode: 'index', intersect: false },
		onClick: onClick
			? (_e: any, els: any[]) => {
					if (els.length) onClick(els[0]);
				}
			: undefined,
		scales: {
			x: { stacked, grid: { display: false } },
			y: {
				stacked,
				title: { display: true, text: 'EUR' },
				grid: {
					color: (c: any) => (c.tick?.value === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.05)')
				}
			}
		},
		plugins: {
			title: { display: true, text: title },
			legend: { position: 'top' },
			tooltip: {
				filter: (c: any) => c.parsed.y !== 0,
				callbacks: { label: (c: any) => `${c.dataset.label}: ${eur(Number(c.parsed.y))}` }
			}
		}
	});

	async function renderMonthly() {
		if (!beancountDB || !monthlyRoot) return;
		const ctx = document.getElementById('chart') as HTMLCanvasElement;
		if (!ctx) return;
		if (chart) chart.destroy();
		chart = null;

		const rows = await beancountDB.getMonthlyByAccount(monthlyRoot, startDate, endDate);
		if (rows.length === 0) {
			monthlyStats = { total: 0, avg: 0, months: 0, top: '' };
			error = `No postings under "${monthlyRoot}" in this range.`;
			return;
		}

		// Color follows the category, not its rank in this range: rank children
		// by all-time size so changing the dates never repaints a category.
		const allTime = await beancountDB.getMonthlyByAccount(monthlyRoot);
		const sizes = new Map<string, number>();
		let allTotal = 0;
		for (const r of allTime) {
			const c = childOf(monthlyRoot, r.account);
			sizes.set(c, (sizes.get(c) || 0) + r.amount);
			allTotal += r.amount;
		}
		// Income-like trees are negative in beancount; show them as positive.
		const sign = allTotal < 0 ? -1 : 1;
		const ranked = [...sizes.keys()].sort((a, b) => Math.abs(sizes.get(b)!) - Math.abs(sizes.get(a)!));
		const topN = Math.max(1, Math.min(monthlyTopN, series.length));
		const shown = ranked.length > topN ? ranked.slice(0, topN - 1) : ranked;
		const shownSet = new Set(shown);

		const months = monthAxis(rows.map((r) => r.month));
		const idx = new Map(months.map((m, i) => [m, i]));
		const byCat = new Map<string, number[]>();
		const other = new Array(months.length).fill(0);
		for (const r of rows) {
			const i = idx.get(r.month);
			if (i == null) continue;
			const c = childOf(monthlyRoot, r.account);
			const target = shownSet.has(c) ? byCat.get(c) || byCat.set(c, new Array(months.length).fill(0)).get(c)! : other;
			target[i] += sign * r.amount;
		}

		const label = (c: string) => (c === monthlyRoot ? `${c.split(':').pop()} (direct)` : c.split(':').pop()!);
		const datasets: any[] = shown
			.filter((c) => byCat.has(c))
			.map((c) => ({
				label: label(c),
				account: c,
				data: byCat.get(c)!.map((v) => Math.round(v * 100) / 100),
				backgroundColor: series[ranked.indexOf(c)],
				borderColor: '#ffffff',
				borderWidth: 1,
				stack: 'cat'
			}));
		if (other.some((v) => v !== 0)) {
			datasets.push({
				label: `Other (${ranked.length - shown.length})`,
				account: null,
				data: other.map((v) => Math.round(v * 100) / 100),
				backgroundColor: otherColor,
				borderColor: '#ffffff',
				borderWidth: 1,
				stack: 'cat'
			});
		}

		const totals = months.map((_, i) => datasets.reduce((s, d) => s + d.data[i], 0));
		const total = totals.reduce((a, b) => a + b, 0);
		const biggest = [...byCat.entries()].sort(
			(a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0)
		)[0];
		monthlyStats = {
			total,
			avg: months.length ? total / months.length : 0,
			months: months.length,
			top: biggest ? label(biggest[0]) : ''
		};

		const options = barOptions(`${monthlyRoot} — per month by sub-account`, true, (el) => {
			const d = datasets[el.datasetIndex];
			const { start, end } = monthBounds(months[el.index]);
			if (d.account) showTransactions(`${d.account} · ${monthLabel(months[el.index])}`, d.account, true, start, end);
			else showTransactions(`${monthlyRoot} · ${monthLabel(months[el.index])}`, monthlyRoot, true, start, end);
		});
		options.plugins.tooltip.callbacks.footer = (items: any[]) =>
			items.length ? `Total: ${eur(totals[items[0].dataIndex])}` : '';

		chart = new Chart(ctx, {
			type: 'bar',
			data: { labels: months.map(monthLabel), datasets },
			options
		});
	}

	async function renderIncome() {
		if (!beancountDB) return;
		const ctx = document.getElementById('chart') as HTMLCanvasElement;
		if (!ctx) return;
		if (chart) chart.destroy();
		chart = null;

		if (!incomeRoot || !expenseRoot) {
			incomeStats = { income: 0, expenses: 0, net: 0, rate: null };
			error = 'Pick both an income and an expenses account.';
			return;
		}
		const [inc, exp] = await Promise.all([
			beancountDB.getMonthlyByAccount(incomeRoot, startDate, endDate),
			beancountDB.getMonthlyByAccount(expenseRoot, startDate, endDate)
		]);
		if (inc.length === 0 && exp.length === 0) {
			incomeStats = { income: 0, expenses: 0, net: 0, rate: null };
			error = 'No income or expenses in this range.';
			return;
		}

		const months = monthAxis([...inc, ...exp].map((r) => r.month).sort());
		const idx = new Map(months.map((m, i) => [m, i]));
		const income = new Array(months.length).fill(0);
		const expenses = new Array(months.length).fill(0);
		// Income postings are negative in beancount; flip them to read as earnings.
		for (const r of inc) if (idx.has(r.month)) income[idx.get(r.month)!] -= r.amount;
		for (const r of exp) if (idx.has(r.month)) expenses[idx.get(r.month)!] += r.amount;
		const round = (v: number) => Math.round(v * 100) / 100;
		const net = months.map((_, i) => round(income[i] - expenses[i]));

		const ti = income.reduce((a, b) => a + b, 0);
		const te = expenses.reduce((a, b) => a + b, 0);
		incomeStats = { income: ti, expenses: te, net: ti - te, rate: ti > 0 ? (ti - te) / ti : null };

		const options = barOptions(`${incomeRoot} vs ${expenseRoot} — per month`, false, (el) => {
			const { start, end } = monthBounds(months[el.index]);
			const acc = el.datasetIndex === 1 ? expenseRoot : incomeRoot;
			showTransactions(`${acc} · ${monthLabel(months[el.index])}`, acc, true, start, end);
		});
		options.plugins.tooltip.callbacks.footer = (items: any[]) => {
			if (!items.length) return '';
			const i = items[0].dataIndex;
			return income[i] > 0 ? `Savings rate: ${Math.round((net[i] / income[i]) * 100)}%` : '';
		};

		chart = new Chart(ctx, {
			type: 'bar',
			data: {
				labels: months.map(monthLabel),
				datasets: [
					{ label: 'Income', data: income.map(round), backgroundColor: series[0], borderRadius: 4, order: 2 },
					{ label: 'Expenses', data: expenses.map(round), backgroundColor: series[1], borderRadius: 4, order: 2 },
					{
						type: 'line',
						label: 'Net (saved)',
						data: net,
						borderColor: inkColor,
						backgroundColor: inkColor,
						borderWidth: 2,
						pointRadius: 4,
						pointBorderColor: '#ffffff',
						pointBorderWidth: 2,
						tension: 0.2,
						order: 1
					} as any
				]
			},
			options
		});
	}

	async function renderNetWorth() {
		if (!beancountDB) return;
		const ctx = document.getElementById('chart') as HTMLCanvasElement;
		if (!ctx) return;
		if (chart) chart.destroy();
		chart = null;

		if (assetRoots.length === 0 && liabilityRoots.length === 0) {
			netWorthData = [];
			error = 'Tick at least one asset or liability account.';
			return;
		}
		netWorthData = await beancountDB.getNetWorthHistory(assetRoots, liabilityRoots, startDate, endDate);
		if (netWorthData.length === 0) {
			error = 'No asset or liability postings up to this date.';
			return;
		}

		const line = (label: string, key: 'netWorth' | 'assets' | 'liabilities', color: string, extra: any = {}) => ({
			label,
			data: netWorthData.map((d) => ({ x: d.date, y: d[key] })),
			borderColor: color,
			backgroundColor: color,
			borderWidth: 2,
			pointRadius: 0,
			stepped: true,
			...extra
		});
		const datasets: any[] = [
			line('Net worth', 'netWorth', series[0], { fill: 'origin', backgroundColor: 'rgba(42, 120, 214, 0.10)', borderWidth: 2.5 })
		];
		if (assetRoots.length && liabilityRoots.length) {
			datasets.push(line('Assets', 'assets', series[2], { borderDash: [5, 4] }));
			datasets.push(line('Liabilities', 'liabilities', series[1], { borderDash: [5, 4] }));
		}

		chart = new Chart(ctx, {
			type: 'line',
			data: { datasets },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				interaction: { mode: 'index', intersect: false },
				scales: {
					x: { type: 'time', time: { unit: 'month', tooltipFormat: 'yyyy-MM-dd' }, grid: { display: false } },
					y: {
						title: { display: true, text: 'EUR' },
						grid: { color: (c: any) => (c.tick?.value === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.05)') }
					}
				},
				plugins: {
					title: { display: true, text: 'Net worth (assets + liabilities)' },
					legend: { position: 'top' },
					tooltip: { callbacks: { label: (c: any) => `${c.dataset.label}: ${eur(Number(c.parsed.y))}` } }
				}
			} as any
		});
	}

	function toggleRoot(list: 'asset' | 'liability', root: string, on: boolean) {
		if (list === 'asset') assetRoots = on ? [...assetRoots, root] : assetRoots.filter((r) => r !== root);
		else liabilityRoots = on ? [...liabilityRoots, root] : liabilityRoots.filter((r) => r !== root);
		refresh();
	}

	const HEAT_CELL = 13;
	const HEAT_GAP = 3;
	const HEAT_LEFT = 28;
	const HEAT_TOP = 16;

	async function renderHeatmap() {
		if (!beancountDB || !selectedAccount) return;
		const days = await beancountDB.getDailyTotals(selectedAccount, includeDescendants, startDate, endDate);
		heatHover = null;
		if (days.length === 0) {
			heatYears = [];
			heatStats = { total: 0, activeDays: 0, perDay: 0, maxDate: '', max: 0 };
			error = `No postings for "${selectedAccount}" in this range.`;
			return;
		}

		// Show whichever direction dominates as positive (e.g. income, expenses).
		const rawTotal = days.reduce((s, d) => s + d.amount, 0);
		heatFlip = rawTotal < 0 ? -1 : 1;
		const values = new Map(days.map((d) => [d.date, heatFlip * d.amount]));

		// Bucket by quantiles so one huge day doesn't wash out everything else.
		const pos = [...values.values()].filter((v) => v > 0).sort((a, b) => a - b);
		const neg = [...values.values()].filter((v) => v < 0).map((v) => -v).sort((a, b) => a - b);
		const cuts = (arr: number[], n: number) =>
			Array.from({ length: n - 1 }, (_, i) => arr[Math.floor(((i + 1) / n) * arr.length)] ?? Infinity);
		const posCuts = cuts(pos, heatRamp.length);
		const negCuts = cuts(neg, heatNegRamp.length);
		const bucket = (v: number, c: number[]) => {
			let i = 0;
			while (i < c.length && v >= c[i]) i++;
			return i;
		};
		const colorFor = (v: number | null) => {
			if (v == null || Math.abs(v) < 0.005) return heatEmpty;
			return v > 0 ? heatRamp[bucket(v, posCuts)] : heatNegRamp[bucket(-v, negCuts)];
		};
		heatLegend = [heatEmpty, ...heatRamp];

		const first = parseLocal(startDate || days[0].date);
		const last = parseLocal(endDate || days[days.length - 1].date);
		const years: HeatYear[] = [];
		for (let y = first.getFullYear(); y <= last.getFullYear(); y++) {
			const from = y === first.getFullYear() ? first : new Date(y, 0, 1);
			const to = y === last.getFullYear() ? last : new Date(y, 11, 31);
			const jan1 = new Date(y, 0, 1);
			// Monday-based week columns, counted from the week holding Jan 1.
			const offset = (jan1.getDay() + 6) % 7;
			const cells: HeatCell[] = [];
			const months: { label: string; x: number }[] = [];
			let maxX = 0;
			for (let d = from; d <= to; d = addDays(d, 1)) {
				const doy = Math.round((d.getTime() - jan1.getTime()) / 86400000);
				const col = Math.floor((doy + offset) / 7);
				const row = (d.getDay() + 6) % 7;
				const x = HEAT_LEFT + col * (HEAT_CELL + HEAT_GAP);
				const date = fmtDate(d);
				const amount = values.has(date) ? values.get(date)! : null;
				cells.push({ date, x, y: HEAT_TOP + row * (HEAT_CELL + HEAT_GAP), amount, color: colorFor(amount) });
				// Label the first partial month only if there's room before the next one.
				if (d.getDate() === 1 || (cells.length === 1 && d.getDate() <= 18)) {
					months.push({ label: d.toLocaleDateString('en-GB', { month: 'short' }), x });
				}
				maxX = Math.max(maxX, x);
			}
			years.push({ year: y, width: maxX + HEAT_CELL + 4, cells, months });
		}
		heatYears = years;

		const flipped = days.map((d) => ({ date: d.date, v: heatFlip * d.amount }));
		const maxDay = flipped.reduce((m, d) => (d.v > m.v ? d : m), flipped[0]);
		const active = flipped.filter((d) => Math.abs(d.v) >= 0.005).length;
		const total = heatFlip * rawTotal;
		heatStats = { total, activeDays: active, perDay: active ? total / active : 0, maxDate: maxDay.date, max: maxDay.v };
	}

	function resetDates() {
		if (dataRange) {
			startDate = dataRange.start;
			endDate = dataRange.end;
			refresh();
		}
	}

	function fmtDate(d: Date): string {
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	let activeRange = 'all';

	type QuickRange = { id: string; label: string; compute: () => { start: string; end: string } };

	const quickRanges: QuickRange[] = [
		{
			id: 'this-month',
			label: 'This month',
			compute: () => {
				const now = new Date();
				return { start: fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)), end: fmtDate(now) };
			}
		},
		{
			id: 'last-month',
			label: 'Last month',
			compute: () => {
				const now = new Date();
				return {
					start: fmtDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
					end: fmtDate(new Date(now.getFullYear(), now.getMonth(), 0))
				};
			}
		},
		{
			id: 'last-3-months',
			label: 'Last 3 months',
			compute: () => {
				const now = new Date();
				return { start: fmtDate(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate())), end: fmtDate(now) };
			}
		},
		{
			id: 'ytd',
			label: 'Year to date',
			compute: () => {
				const now = new Date();
				return { start: fmtDate(new Date(now.getFullYear(), 0, 1)), end: fmtDate(now) };
			}
		},
		{
			id: 'this-year',
			label: 'This year',
			compute: () => {
				const now = new Date();
				return { start: fmtDate(new Date(now.getFullYear(), 0, 1)), end: fmtDate(new Date(now.getFullYear(), 11, 31)) };
			}
		},
		{
			id: 'last-year',
			label: 'Last year',
			compute: () => {
				const y = new Date().getFullYear() - 1;
				return { start: fmtDate(new Date(y, 0, 1)), end: fmtDate(new Date(y, 11, 31)) };
			}
		}
	];

	function applyQuickRange(range: QuickRange) {
		const { start, end } = range.compute();
		startDate = start;
		endDate = end;
		activeRange = range.id;
		refresh();
	}

	function applyAllTime() {
		activeRange = 'all';
		resetDates();
	}

	function handleManualDate() {
		activeRange = 'custom';
		refresh();
	}

	function shiftRange(unit: 'month' | 'year', dir: 1 | -1) {
		if (!startDate || !endDate) return;
		const s = new Date(startDate);
		const e = new Date(endDate);
		if (unit === 'month') {
			s.setMonth(s.getMonth() + dir);
			e.setMonth(e.getMonth() + dir);
		} else {
			s.setFullYear(s.getFullYear() + dir);
			e.setFullYear(e.getFullYear() + dir);
		}
		startDate = fmtDate(s);
		endDate = fmtDate(e);
		activeRange = 'custom';
		refresh();
	}

	function onAccountChange() {
		// Group accounts have no postings of their own, so rolling up sub-accounts
		// is the only way to see a total — enable it automatically.
		if (isGroupAccount(selectedAccount)) includeDescendants = true;
		refresh();
	}

	function toggleCompare() {
		// On enable, seed the baseline with the current start so the diff is flat
		// (comparing the period against itself) until the user shifts it.
		if (compareEnabled) compareStart = startDate;
		refresh();
	}

	function shiftCompare(unit: 'month' | 'year', dir: 1 | -1) {
		if (!compareStart) return;
		const s = parseLocal(compareStart);
		if (unit === 'month') s.setMonth(s.getMonth() + dir);
		else s.setFullYear(s.getFullYear() + dir);
		compareStart = fmtDate(s);
		refresh();
	}

	function applyZoom(next: number, anchor?: { x: number; y: number; sl: number; st: number }) {
		const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
		const prev = zoom;
		zoom = clamped;
		// Keep the cursor anchored to the same content point while zooming.
		requestAnimationFrame(() => {
			chart?.resize();
			if (viewport && anchor && prev !== clamped) {
				const ratio = clamped / prev;
				viewport.scrollLeft = (anchor.sl + anchor.x) * ratio - anchor.x;
				viewport.scrollTop = (anchor.st + anchor.y) * ratio - anchor.y;
			}
		});
	}

	function zoomBy(delta: number) {
		applyZoom(zoom + delta);
	}

	function resetZoom() {
		zoom = ZOOM_MIN;
		requestAnimationFrame(() => chart?.resize());
	}

	function handleWheel(event: WheelEvent) {
		if (!(event.ctrlKey || event.metaKey)) return;
		event.preventDefault();
		const rect = viewport.getBoundingClientRect();
		const anchor = {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
			sl: viewport.scrollLeft,
			st: viewport.scrollTop
		};
		applyZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), anchor);
	}

	function captureCurrent(): DashboardPreset {
		return {
			id: makeId(),
			name: presetName.trim(),
			view,
			account: selectedAccount,
			includeDescendants,
			startDate,
			endDate,
			windowSize,
			showBalance,
			showDailyRate,
			useEMA,
			flowRoot,
			flowMaxDepth,
			flowMinAmount,
			monthlyRoot,
			monthlyTopN,
			incomeRoot,
			expenseRoot,
			assetRoots,
			liabilityRoots,
			createdAt: Date.now()
		};
	}

	function handleSavePreset() {
		const name = presetName.trim();
		if (!name) {
			error = 'Enter a name for the preset.';
			return;
		}
		presets = upsertPreset(captureCurrent());
		presetName = '';
	}

	async function applyPreset(p: DashboardPreset) {
		view = p.view;
		selectedAccount = accounts.includes(p.account) ? p.account : selectedAccount;
		includeDescendants = p.includeDescendants;
		startDate = p.startDate;
		endDate = p.endDate;
		windowSize = p.windowSize;
		showBalance = p.showBalance;
		showDailyRate = p.showDailyRate;
		useEMA = p.useEMA;
		flowRoot = topRoots.includes(p.flowRoot) ? p.flowRoot : flowRoot;
		flowMaxDepth = p.flowMaxDepth;
		flowMinAmount = p.flowMinAmount;
		if (p.monthlyRoot && accounts.includes(p.monthlyRoot)) monthlyRoot = p.monthlyRoot;
		if (p.monthlyTopN) monthlyTopN = p.monthlyTopN;
		if (p.incomeRoot) incomeRoot = p.incomeRoot;
		if (p.expenseRoot) expenseRoot = p.expenseRoot;
		if (p.assetRoots) assetRoots = [...p.assetRoots];
		if (p.liabilityRoots) liabilityRoots = [...p.liabilityRoots];
		applyRootDefaults();
		await refresh();
	}

	function handleDeletePreset(id: string) {
		presets = deletePreset(id);
	}

	async function handleReupload(event: Event) {
		const target = event.target as HTMLInputElement;
		const files = target.files;
		if (!files || files.length === 0 || !beancountDB) return;
		isLoading = true;
		error = null;
		try {
			const next: StoredFile[] = [];
			for (let i = 0; i < files.length; i++) {
				next.push({ name: files[i].name, content: await files[i].text() });
			}
			dataFiles = next;
			saveLoadedData(next);
			sessionStorage.setItem('beancountData', JSON.stringify(next));
			await beancountDB.loadBeancountData(next);
			postingAccounts = await beancountDB.getAllAccounts();
			accounts = expandWithParents(postingAccounts);
			dataRange = await beancountDB.getDateRange();
			topRoots = deriveRoots(accounts);
			applyRootDefaults();
			if (!accounts.includes(selectedAccount) && accounts.length > 0) selectedAccount = accounts[0];
			await refresh();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load files';
		} finally {
			isLoading = false;
			target.value = '';
		}
	}

	function presetSummary(p: DashboardPreset): string {
		const tab = tabs.find((t) => t.id === p.view)?.label ?? p.view;
		switch (p.view) {
			case 'trends':
			case 'heatmap':
				return `${tab} · ${p.account}`;
			case 'cashflow':
				return `${p.flowRoot} · depth ${p.flowMaxDepth}`;
			case 'monthly':
				return `${tab} · ${p.monthlyRoot ?? p.flowRoot}`;
			default:
				return tab;
		}
	}

	$: latestPoint = runningAverageData.length ? runningAverageData[runningAverageData.length - 1] : null;
</script>

<div class="min-h-screen bg-gray-100 px-4 py-8">
	<div class="mx-auto max-w-7xl">
		<div class="mb-6 flex flex-wrap items-center justify-between gap-3">
			<h1 class="text-3xl font-bold text-gray-900">Beancount Dashboard</h1>
			<div class="flex items-center gap-3 text-sm">
				{#if dataRange}
					<span class="text-gray-500">{dataRange.start} → {dataRange.end} · {dataFiles.length} file(s)</span>
				{/if}
				<label class="cursor-pointer rounded-md bg-white px-3 py-2 font-medium text-blue-700 shadow-sm ring-1 ring-blue-200 hover:bg-blue-50">
					Update data
					<input type="file" accept=".bean,.beancount" multiple class="hidden" on:change={handleReupload} />
				</label>
				<button
					on:click={() => goto(resolve('/'))}
					class="rounded-md bg-white px-3 py-2 font-medium text-gray-700 shadow-sm ring-1 ring-gray-200 hover:bg-gray-50"
				>
					Home
				</button>
			</div>
		</div>

		{#if isLoading}
			<div class="flex items-center justify-center rounded-lg bg-white py-16 shadow-sm">
				<div class="text-lg text-gray-600">Loading beancount data…</div>
			</div>
		{:else if error && accounts.length === 0}
			<div class="rounded-md border border-red-200 bg-red-50 p-4">
				<p class="text-sm text-red-600">{error}</p>
			</div>
		{:else}
			<div class="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
				<!-- Presets sidebar -->
				<aside class="rounded-lg bg-white p-4 shadow-sm">
					<h2 class="mb-3 text-sm font-semibold tracking-wide text-gray-500 uppercase">Saved views</h2>

					<div class="mb-4 flex gap-2">
						<input
							type="text"
							placeholder="Name this view"
							bind:value={presetName}
							class="min-w-0 flex-1 rounded-md border-gray-300 text-sm shadow-sm focus:border-blue-500 focus:ring-blue-500"
						/>
						<button
							on:click={handleSavePreset}
							class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
						>
							Save
						</button>
					</div>

					{#if presets.length === 0}
						<p class="text-sm text-gray-400">No saved views yet. Configure a chart and save it — it stays available when you return with updated files.</p>
					{:else}
						<ul class="space-y-2">
							{#each presets as p (p.id)}
								<li class="group flex items-center justify-between rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
									<button class="min-w-0 flex-1 text-left" on:click={() => applyPreset(p)}>
										<span class="block truncate text-sm font-medium text-gray-800">{p.name}</span>
										<span class="block truncate text-xs text-gray-400">
											{presetSummary(p)}
										</span>
									</button>
									<button
										title="Delete"
										on:click={() => handleDeletePreset(p.id)}
										class="ml-2 text-gray-300 hover:text-red-500"
									>
										✕
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</aside>

				<!-- Main panel -->
				<section class="rounded-lg bg-white p-6 shadow-sm">
					<!-- Tabs -->
					<div class="mb-5 flex gap-1 overflow-x-auto border-b border-gray-200">
						{#each tabs as t (t.id)}
							<button
								class="-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium {view === t.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}"
								on:click={() => setView(t.id)}
							>
								{t.label}
							</button>
						{/each}
					</div>

					<!-- Compare with an earlier/later period of the same width -->
					{#if supportsCompare}
					<div class="mb-5 rounded-md bg-gray-50 px-3 py-2">
						<label class="flex items-center gap-2 text-sm font-medium text-gray-700">
							<input
								type="checkbox"
								bind:checked={compareEnabled}
								on:change={toggleCompare}
								class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
							/>
							Compare with another period (show difference)
						</label>

						<div
							class="mt-3 flex flex-wrap items-end gap-4 {compareEnabled
								? ''
								: 'pointer-events-none opacity-40'}"
						>
							<div>
								<label for="compare-start" class="mb-1 block text-sm font-medium text-gray-700">Baseline start</label>
								<input
									id="compare-start"
									type="date"
									bind:value={compareStart}
									on:change={refresh}
									disabled={!compareEnabled}
									class="block rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
								/>
							</div>
							<div>
								<label for="compare-end" class="mb-1 block text-sm font-medium text-gray-700">Baseline end</label>
								<input
									id="compare-end"
									type="date"
									value={compareEnd}
									readonly
									tabindex="-1"
									class="block cursor-not-allowed rounded-md border-gray-200 bg-gray-100 text-gray-500 shadow-sm"
								/>
							</div>
							<div>
								<span class="mb-1 block text-sm font-medium text-gray-700">Shift baseline</span>
								<div class="inline-flex overflow-hidden rounded-md border border-gray-300">
									<button on:click={() => shiftCompare('year', -1)} disabled={!compareEnabled} title="Back one year" class="border-r border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-600 hover:bg-gray-50">−1y</button>
									<button on:click={() => shiftCompare('month', -1)} disabled={!compareEnabled} title="Back one month" class="border-r border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-600 hover:bg-gray-50">−1m</button>
									<button on:click={() => shiftCompare('month', 1)} disabled={!compareEnabled} title="Forward one month" class="border-r border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-600 hover:bg-gray-50">+1m</button>
									<button on:click={() => shiftCompare('year', 1)} disabled={!compareEnabled} title="Forward one year" class="bg-white px-2.5 py-2 text-sm text-gray-600 hover:bg-gray-50">+1y</button>
								</div>
							</div>
						</div>

						{#if compareRange && view === 'cashflow'}
							<div class="mt-2 flex items-center gap-3 text-xs text-gray-500">
								<span class="flex items-center gap-1"><span class="inline-block h-2 w-3 rounded-sm bg-red-600"></span>more</span>
								<span class="flex items-center gap-1"><span class="inline-block h-2 w-3 rounded-sm bg-green-600"></span>less</span>
								<span>vs {compareRange.startDate} → {compareRange.endDate}</span>
							</div>
						{:else if compareRange}
							<p class="mt-2 text-xs text-gray-500">Showing change vs {compareRange.startDate} → {compareRange.endDate} (flat = identical). Baseline end follows the current range width.</p>
						{/if}
					</div>
					{/if}

					<!-- Controls -->
					{#if view === 'trends' || view === 'heatmap'}
						<div class="mb-5 flex flex-wrap items-end gap-4">
							<div class="min-w-56 flex-1">
								<label for="account-select" class="mb-1 block text-sm font-medium text-gray-700">Account</label>
								<select
									id="account-select"
									bind:value={selectedAccount}
									on:change={onAccountChange}
									class="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
								>
									{#each accounts as account}
										<option value={account}>{account}{isGroupAccount(account) ? ' — group (rolls up)' : ''}</option>
									{/each}
								</select>
							</div>
							<label class="flex items-center gap-2 pb-2 text-sm text-gray-700">
								<input type="checkbox" bind:checked={includeDescendants} on:change={refresh} class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
								<span title="When on, totals roll up all sub-accounts (e.g. Uitgaven:Eten includes Uitgaven:Eten:Frietjes).">
									Include sub-accounts (roll up totals)
								</span>
							</label>
							{#if view === 'trends'}
							<div>
								<label for="window-size" class="mb-1 block text-sm font-medium text-gray-700">Window (days)</label>
								<input id="window-size" type="number" min="1" max="365" bind:value={windowSize} on:change={refresh} class="block w-24 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500" />
							</div>
							<label class="flex items-center gap-2 pb-2 text-sm text-gray-700">
								<input type="checkbox" bind:checked={showBalance} on:change={refresh} class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
								Show balance
							</label>
							<label class="flex items-center gap-2 pb-2 text-sm text-gray-700">
								<input type="checkbox" bind:checked={showDailyRate} on:change={refresh} class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
								Daily rate
							</label>
							<label class="flex items-center gap-2 pb-2 text-sm text-gray-700">
								<input type="checkbox" bind:checked={useEMA} on:change={refresh} class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
								Smooth (EMA)
							</label>
							{/if}
						</div>
					{:else if view === 'monthly'}
						<div class="mb-5 flex flex-wrap items-end gap-4">
							<div class="min-w-56 flex-1">
								<label for="monthly-root" class="mb-1 block text-sm font-medium text-gray-700">Split account</label>
								<select
									id="monthly-root"
									bind:value={monthlyRoot}
									on:change={refresh}
									class="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
								>
									{#each accounts as account}
										<option value={account}>{account}</option>
									{/each}
								</select>
							</div>
							<div>
								<label for="monthly-topn" class="mb-1 block text-sm font-medium text-gray-700">Categories</label>
								<input id="monthly-topn" type="number" min="1" max={series.length} bind:value={monthlyTopN} on:change={refresh} class="block w-24 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500" />
							</div>
							<p class="pb-2 text-sm text-gray-400">Bars stack the direct sub-accounts per month; the smallest fold into “Other”. Click a segment to list its transactions.</p>
						</div>
					{:else if view === 'income'}
						<div class="mb-5 flex flex-wrap items-end gap-4">
							<div class="min-w-48 flex-1">
								<label for="income-root" class="mb-1 block text-sm font-medium text-gray-700">Income account</label>
								<select id="income-root" bind:value={incomeRoot} on:change={refresh} class="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500">
									{#each topRoots as r}
										<option value={r}>{r}</option>
									{/each}
								</select>
							</div>
							<div class="min-w-48 flex-1">
								<label for="expense-root" class="mb-1 block text-sm font-medium text-gray-700">Expenses account</label>
								<select id="expense-root" bind:value={expenseRoot} on:change={refresh} class="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500">
									{#each topRoots as r}
										<option value={r}>{r}</option>
									{/each}
								</select>
							</div>
							<p class="pb-2 text-sm text-gray-400">Net = income − expenses. Click a bar to list its transactions.</p>
						</div>
					{:else if view === 'networth'}
						<div class="mb-5 flex flex-wrap items-start gap-8">
							<fieldset>
								<legend class="mb-1 text-sm font-medium text-gray-700">Assets</legend>
								<div class="flex flex-wrap gap-x-4 gap-y-1">
									{#each topRoots as r}
										<label class="flex items-center gap-2 text-sm text-gray-700">
											<input type="checkbox" checked={assetRoots.includes(r)} on:change={(e) => toggleRoot('asset', r, e.currentTarget.checked)} class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
											{r}
										</label>
									{/each}
								</div>
							</fieldset>
							<fieldset>
								<legend class="mb-1 text-sm font-medium text-gray-700">Liabilities</legend>
								<div class="flex flex-wrap gap-x-4 gap-y-1">
									{#each topRoots as r}
										<label class="flex items-center gap-2 text-sm text-gray-700">
											<input type="checkbox" checked={liabilityRoots.includes(r)} on:change={(e) => toggleRoot('liability', r, e.currentTarget.checked)} class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
											{r}
										</label>
									{/each}
								</div>
							</fieldset>
							<p class="text-sm text-gray-400">Balances accumulate from your first transaction, so the start date only trims the view.</p>
						</div>
					{:else}
						<div class="mb-5 flex flex-wrap items-end gap-4">
							<div class="min-w-56 flex-1">
								<label for="flow-root" class="mb-1 block text-sm font-medium text-gray-700">Root account</label>
								<select
									id="flow-root"
									bind:value={flowRoot}
									on:change={refresh}
									class="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
								>
									{#each topRoots as r}
										<option value={r}>{r}</option>
									{/each}
								</select>
							</div>
							<div>
								<label for="flow-depth" class="mb-1 block text-sm font-medium text-gray-700">Levels deep</label>
								<input id="flow-depth" type="number" min="1" max="6" bind:value={flowMaxDepth} on:change={refresh} class="block w-24 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500" />
							</div>
							<div>
								<label for="flow-min" class="mb-1 block text-sm font-medium text-gray-700">Min amount (EUR)</label>
								<input id="flow-min" type="number" min="0" step="10" bind:value={flowMinAmount} on:change={refresh} class="block w-28 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500" />
							</div>
							<p class="pb-2 text-sm text-gray-400">Flows split the chosen account into its sub-accounts; link width = total amount in the period.</p>
						</div>
					{/if}

					<!-- Date range (shared) -->
					<div class="mb-5 space-y-3">
						<!-- Quick range chips -->
						<div class="flex flex-wrap items-center gap-2">
							{#each quickRanges as r}
								<button
									on:click={() => applyQuickRange(r)}
									class="rounded-full border px-3 py-1 text-sm transition-colors {activeRange === r.id
										? 'border-blue-600 bg-blue-600 text-white'
										: 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}"
								>
									{r.label}
								</button>
							{/each}
							<button
								on:click={applyAllTime}
								class="rounded-full border px-3 py-1 text-sm transition-colors {activeRange === 'all'
									? 'border-blue-600 bg-blue-600 text-white'
									: 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}"
							>
								All time
							</button>
						</div>

						<!-- Date inputs + shift steppers -->
						<div class="flex flex-wrap items-end gap-4">
							<div>
								<label for="start-date" class="mb-1 block text-sm font-medium text-gray-700">Start date</label>
								<input id="start-date" type="date" bind:value={startDate} on:change={handleManualDate} class="block rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500" />
							</div>
							<div>
								<label for="end-date" class="mb-1 block text-sm font-medium text-gray-700">End date</label>
								<input id="end-date" type="date" bind:value={endDate} on:change={handleManualDate} class="block rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500" />
							</div>

							<div>
								<span class="mb-1 block text-sm font-medium text-gray-700">Shift window</span>
								<div class="inline-flex overflow-hidden rounded-md border border-gray-300">
									<button on:click={() => shiftRange('year', -1)} title="Back one year" class="border-r border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-600 hover:bg-gray-50">−1y</button>
									<button on:click={() => shiftRange('month', -1)} title="Back one month" class="border-r border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-600 hover:bg-gray-50">−1m</button>
									<button on:click={() => shiftRange('month', 1)} title="Forward one month" class="border-r border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-600 hover:bg-gray-50">+1m</button>
									<button on:click={() => shiftRange('year', 1)} title="Forward one year" class="bg-white px-2.5 py-2 text-sm text-gray-600 hover:bg-gray-50">+1y</button>
								</div>
							</div>
						</div>
					</div>

					{#if error}
						<div class="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3">
							<p class="text-sm text-amber-700">{error}</p>
						</div>
					{/if}

					<!-- Chart -->
					{#if view === 'heatmap'}
					<div class="mb-6">
						<div class="mb-2 flex flex-wrap items-center justify-between gap-3 text-sm">
							<div class="min-h-5 text-gray-600">
								{#if heatHover}
									<span class="font-medium text-gray-800">{parseLocal(heatHover.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
									· {heatHover.amount == null ? 'no postings' : eur(heatHover.amount)}
								{:else}
									<span class="text-gray-400">Hover a day for its total · click to list its transactions</span>
								{/if}
							</div>
							<div class="flex items-center gap-1 text-xs text-gray-500">
								<span class="mr-1">Less</span>
								{#each heatLegend as c}
									<span class="inline-block h-3 w-3 rounded-sm" style="background: {c}"></span>
								{/each}
								<span class="ml-1">More</span>
								<span class="ml-3 inline-block h-3 w-3 rounded-sm" style="background: {heatNegRamp[2]}"></span>
								<span>{heatFlip < 0 ? 'Outflow' : 'Refund / inflow'}</span>
							</div>
						</div>
						<div class="max-h-[28rem] space-y-4 overflow-auto rounded-md border border-gray-100 p-3">
							{#each heatYears as yr (yr.year)}
								<div>
									<div class="mb-1 text-sm font-semibold text-gray-700">{yr.year}</div>
									<svg width={yr.width} height={HEAT_TOP + 7 * (HEAT_CELL + HEAT_GAP)} role="img" aria-label="Daily totals for {yr.year}">
										{#each yr.months as m}
											<text x={m.x} y="10" class="fill-gray-400 text-[10px]">{m.label}</text>
										{/each}
										{#each ['Mon', 'Wed', 'Fri'] as d, i}
											<text x="0" y={HEAT_TOP + i * 2 * (HEAT_CELL + HEAT_GAP) + HEAT_CELL - 3} class="fill-gray-400 text-[10px]">{d}</text>
										{/each}
										{#each yr.cells as c (c.date)}
											<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
											<rect
												x={c.x}
												y={c.y}
												width={HEAT_CELL}
												height={HEAT_CELL}
												rx="3"
												fill={c.color}
												stroke={heatHover === c || selRange?.start === c.date ? '#111827' : 'none'}
												stroke-width="1.5"
												class="cursor-pointer"
												on:mouseenter={() => (heatHover = c)}
												on:mouseleave={() => (heatHover = null)}
												on:click={() => showTransactions(selectedAccount, selectedAccount, includeDescendants, c.date, c.date)}
											>
												<title>{c.date}: {c.amount == null ? 'no postings' : eur(c.amount)}</title>
											</rect>
										{/each}
									</svg>
								</div>
							{/each}
						</div>
					</div>
					{:else}
					<div class="mb-6">
						<div class="mb-2 flex items-center justify-end gap-1 text-sm">
							<span class="mr-2 text-gray-400">Zoom</span>
							<button on:click={() => zoomBy(-0.25)} class="h-7 w-7 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50" aria-label="Zoom out">−</button>
							<span class="w-12 text-center tabular-nums text-gray-500">{Math.round(zoom * 100)}%</span>
							<button on:click={() => zoomBy(0.25)} class="h-7 w-7 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50" aria-label="Zoom in">+</button>
							<button on:click={resetZoom} class="ml-1 h-7 rounded border border-gray-200 bg-white px-2 text-gray-600 hover:bg-gray-50">Reset</button>
						</div>
						<div
							bind:this={viewport}
							class="chart-viewport h-[28rem] w-full overflow-auto rounded-md border border-gray-100"
							on:wheel={handleWheel}
						>
							<div class="chart-stage select-none" style="width: {100 * zoom}%; height: {28 * zoom}rem;">
								<canvas id="chart"></canvas>
							</div>
						</div>
						<p class="mt-1 text-xs text-gray-400">
							Ctrl/⌘ + scroll to zoom · drag the scrollbars to pan{#if view === 'trends'}{' · '}<span class="text-gray-500">drag across the chart to select a range and list its transactions</span>{:else if view === 'monthly' || view === 'income'}{' · '}<span class="text-gray-500">click a bar to list its transactions</span>{/if}.
						</p>
					</div>
					{/if}

					<!-- Selected-range transactions -->
					{#if selRange}
						<div class="mb-6 rounded-lg border border-blue-100 bg-blue-50/40">
							<div class="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 px-4 py-3">
								<div>
									<h3 class="text-sm font-semibold text-gray-800">
										{selLabel} · {selRange.start === selRange.end ? selRange.start : `${selRange.start} → ${selRange.end}`}
									</h3>
									<p class="text-xs text-gray-500">
										{selectedTransactions.length}
										{selectedTransactions.length === 1 ? 'posting' : 'postings'} · net €{selTotal.toFixed(2)}
									</p>
								</div>
								<div class="flex items-center gap-2">
									<div class="inline-flex overflow-hidden rounded-md border border-gray-300 text-sm">
										<button
											on:click={() => (txSort = 'amount')}
											class="px-2.5 py-1 {txSort === 'amount' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}"
										>
											Biggest
										</button>
										<button
											on:click={() => (txSort = 'date')}
											class="border-l border-gray-300 px-2.5 py-1 {txSort === 'date' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}"
										>
											By date
										</button>
									</div>
									<button
										on:click={clearSelection}
										class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50"
									>
										Clear
									</button>
								</div>
							</div>
							{#if selectedTransactions.length === 0}
								<p class="px-4 py-4 text-sm text-gray-500">No transactions in this range.</p>
							{:else}
								<div class="max-h-80 overflow-auto">
									<table class="w-full text-sm">
										<thead class="sticky top-0 bg-white text-left text-xs uppercase tracking-wide text-gray-400">
											<tr>
												<th class="px-4 py-2 font-medium">Date</th>
												<th class="px-4 py-2 font-medium">Description</th>
												{#if selShowAccount}
													<th class="px-4 py-2 font-medium">Account</th>
												{/if}
												<th class="px-4 py-2 text-right font-medium">Amount</th>
											</tr>
										</thead>
										<tbody>
											{#each sortedTransactions as t}
												<tr class="border-t border-gray-100 hover:bg-white">
													<td class="whitespace-nowrap px-4 py-2 text-gray-500">{t.date}</td>
													<td class="px-4 py-2 text-gray-800">
														{t.payee || t.narration || '—'}
														{#if t.payee && t.narration && t.payee !== t.narration}<span class="text-gray-400"> · {t.narration}</span>{/if}
													</td>
													{#if selShowAccount}
														<td class="px-4 py-2 text-gray-500">{t.account}</td>
													{/if}
													<td class="whitespace-nowrap px-4 py-2 text-right tabular-nums {t.amount < 0 ? 'text-red-600' : 'text-gray-800'}">
														€{t.amount.toFixed(2)}
													</td>
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
							{/if}
						</div>
					{/if}

					<!-- Stats -->
					{#if view === 'trends'}
						<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Current balance</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{latestPoint ? `€${latestPoint.balance.toFixed(2)}` : 'N/A'}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">{showDailyRate ? 'Avg daily rate' : `Avg per ${windowSize}d`}</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{latestPoint ? `€${latestPoint.runningAverage.toFixed(2)}` : 'N/A'}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Data points</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{runningAverageData.length}</p>
							</div>
						</div>
					{:else if view === 'monthly'}
						<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Total in range</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{eur(monthlyStats.total)}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Average per month ({monthlyStats.months} months)</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{eur(monthlyStats.avg)}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Largest category</h3>
								<p class="mt-1 truncate text-2xl font-bold text-gray-900">{monthlyStats.top || 'N/A'}</p>
							</div>
						</div>
					{:else if view === 'income'}
						<div class="grid grid-cols-1 gap-4 md:grid-cols-4">
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Income</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{eur(incomeStats.income)}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Expenses</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{eur(incomeStats.expenses)}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Net saved</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{eur(incomeStats.net)}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Savings rate</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{incomeStats.rate == null ? 'N/A' : `${Math.round(incomeStats.rate * 100)}%`}</p>
							</div>
						</div>
					{:else if view === 'networth'}
						{@const first = netWorthData[0]}
						{@const last = netWorthData[netWorthData.length - 1]}
						<div class="grid grid-cols-1 gap-4 md:grid-cols-4">
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Net worth{last ? ` on ${last.date}` : ''}</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{last ? eur(last.netWorth) : 'N/A'}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Change over range</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{first && last ? `${last.netWorth >= first.netWorth ? '+' : ''}${eur(last.netWorth - first.netWorth)}` : 'N/A'}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Assets</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{last ? eur(last.assets) : 'N/A'}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Liabilities</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{last ? eur(last.liabilities) : 'N/A'}</p>
							</div>
						</div>
					{:else if view === 'heatmap'}
						<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Total in range</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{eur(heatStats.total)}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Avg per active day ({heatStats.activeDays} days)</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{eur(heatStats.perDay)}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Biggest day{heatStats.maxDate ? ` (${heatStats.maxDate})` : ''}</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{heatStats.maxDate ? eur(heatStats.max) : 'N/A'}</p>
							</div>
						</div>
					{:else}
						<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Total under {flowRoot}</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">€{cashFlowTotal.toFixed(2)}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Flow links</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{cashFlow.length}</p>
							</div>
						</div>
					{/if}
				</section>
			</div>
		{/if}
	</div>
</div>

<style>
	.chart-stage {
		min-width: 100%;
		min-height: 100%;
	}
	.chart-stage > canvas {
		width: 100% !important;
		height: 100% !important;
		display: block;
	}
</style>
