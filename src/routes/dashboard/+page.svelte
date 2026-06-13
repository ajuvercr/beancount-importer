<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { createBeancountDB, type BeancountDB, type CashFlowLink } from '$lib/beancount-db';
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

	// Cash-flow controls (hierarchical breakdown of one account tree)
	let flowRoot = '';
	let flowMaxDepth = 2;
	let flowMinAmount = 0;
	let cashFlow: CashFlowLink[] = [];
	let cashFlowTotal = 0;
	let topRoots: string[] = [];

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

	async function refresh() {
		if (!beancountDB) return;
		error = null;
		if (view === 'trends') {
			await renderTrends();
		} else {
			await renderCashFlow();
		}
	}

	async function setView(v: ChartView) {
		view = v;
		await refresh();
	}

	async function renderTrends() {
		if (!beancountDB || !selectedAccount) return;
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
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
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
			if (!accounts.includes(selectedAccount) && accounts.length > 0) selectedAccount = accounts[0];
			await refresh();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load files';
		} finally {
			isLoading = false;
			target.value = '';
		}
	}

	const latest = () => (runningAverageData.length ? runningAverageData[runningAverageData.length - 1] : null);
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
											{p.view === 'trends' ? p.account : `${p.flowRoot} · depth ${p.flowMaxDepth}`}
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
					<div class="mb-5 flex gap-1 border-b border-gray-200">
						<button
							class="-mb-px border-b-2 px-4 py-2 text-sm font-medium {view === 'trends' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}"
							on:click={() => setView('trends')}
						>
							Balance & Trends
						</button>
						<button
							class="-mb-px border-b-2 px-4 py-2 text-sm font-medium {view === 'cashflow' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}"
							on:click={() => setView('cashflow')}
						>
							Cash Flow (Hierarchy)
						</button>
					</div>

					<!-- Compare with an earlier/later period of the same width -->
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

					<!-- Controls -->
					{#if view === 'trends'}
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
							<div class="chart-stage" style="width: {100 * zoom}%; height: {28 * zoom}rem;">
								<canvas id="chart"></canvas>
							</div>
						</div>
						<p class="mt-1 text-xs text-gray-400">Ctrl/⌘ + scroll to zoom · drag the scrollbars to pan.</p>
					</div>

					<!-- Stats -->
					{#if view === 'trends'}
						<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Current balance</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{latest() ? `€${latest()!.balance.toFixed(2)}` : 'N/A'}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">{showDailyRate ? 'Avg daily rate' : `Avg per ${windowSize}d`}</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{latest() ? `€${latest()!.runningAverage.toFixed(2)}` : 'N/A'}</p>
							</div>
							<div class="rounded-lg bg-gray-50 p-4">
								<h3 class="text-sm font-medium text-gray-500">Data points</h3>
								<p class="mt-1 text-2xl font-bold text-gray-900">{runningAverageData.length}</p>
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
