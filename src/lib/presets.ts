import { browser } from '$app/environment';

export type ChartView = 'trends' | 'cashflow';

export interface DashboardPreset {
	id: string;
	name: string;
	view: ChartView;
	account: string;
	includeDescendants: boolean;
	startDate: string;
	endDate: string;
	windowSize: number;
	showBalance: boolean;
	showDailyRate: boolean;
	useEMA: boolean;
	flowRoot: string;
	flowMaxDepth: number;
	flowMinAmount: number;
	createdAt: number;
}

const PRESETS_KEY = 'beancount.presets.v1';
const DATA_KEY = 'beancount.data.v1';

export type StoredFile = { name: string; content: string };

function readJSON<T>(key: string, fallback: T): T {
	if (!browser) return fallback;
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function writeJSON(key: string, value: unknown): void {
	if (!browser) return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch (err) {
		console.warn('Failed to persist to localStorage', err);
	}
}

export function loadPresets(): DashboardPreset[] {
	return readJSON<DashboardPreset[]>(PRESETS_KEY, []);
}

export function savePresets(presets: DashboardPreset[]): void {
	writeJSON(PRESETS_KEY, presets);
}

export function upsertPreset(preset: DashboardPreset): DashboardPreset[] {
	const presets = loadPresets();
	const idx = presets.findIndex((p) => p.id === preset.id || p.name === preset.name);
	if (idx >= 0) {
		presets[idx] = preset;
	} else {
		presets.push(preset);
	}
	savePresets(presets);
	return presets;
}

export function deletePreset(id: string): DashboardPreset[] {
	const presets = loadPresets().filter((p) => p.id !== id);
	savePresets(presets);
	return presets;
}

export function makeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist the most recently loaded beancount files so the dashboard reloads
 * automatically on a return visit. Re-uploading updated files overwrites this,
 * which is what keeps saved presets in sync with fresh data.
 */
export function saveLoadedData(files: StoredFile[]): void {
	writeJSON(DATA_KEY, files);
}

export function loadStoredData(): StoredFile[] | null {
	const data = readJSON<StoredFile[] | null>(DATA_KEY, null);
	return data && data.length > 0 ? data : null;
}

export function clearStoredData(): void {
	if (browser) localStorage.removeItem(DATA_KEY);
}
