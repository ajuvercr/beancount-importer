<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { parseCSV, parseBeancountFile } from '$lib/utils';
	import { resolve } from '$app/paths';
	import { loadStoredData, loadPresets } from '$lib/presets';

	let csvFile: File | null = null;
	let beancountFile: File | null = null;
	let beancountFiles: FileList | null = null;
	let isLoading = false;
	let error: string | null = null;
	let hasStoredData = false;
	let storedPresetCount = 0;

	onMount(() => {
		const stored = loadStoredData();
		hasStoredData = !!stored;
		storedPresetCount = loadPresets().length;
	});

	async function handleStartImport() {
		if (!csvFile || !beancountFile) {
			error = 'Please select both files';
			return;
		}

		isLoading = true;
		error = null;

		try {
			// Parse CSV file
			console.log('CSV file name:', csvFile.name);
			const transactions = await parseCSV(csvFile);
			console.log('Parsed transactions:', transactions.length);

			// Parse beancount file
			const beancountText = await beancountFile.text();
			console.log('Beancount file content length:', beancountText.length);
			console.log('First 200 chars of beancount:', beancountText.substring(0, 200));
			const accounts = parseBeancountFile(beancountText);
			console.log('Parsed accounts:', accounts);

			// Store data in session storage for the import page
			sessionStorage.setItem('transactions', JSON.stringify(transactions));
			sessionStorage.setItem('accounts', JSON.stringify(accounts));
			console.log('Data stored in session storage');

			// Navigate to import page
			goto(resolve('/import'));
		} catch (err) {
			console.error('Error during import:', err);
			error = err instanceof Error ? err.message : 'Failed to parse files';
		} finally {
			isLoading = false;
		}
	}

	async function handleBeancountGraphs() {
		if (!beancountFiles || beancountFiles.length === 0) {
			error = 'Please select beancount files';
			return;
		}

		isLoading = true;
		error = null;

		try {
			// Parse all beancount files
			const beancountData = [];
			for (let i = 0; i < beancountFiles.length; i++) {
				const file = beancountFiles[i];
				const text = await file.text();
				beancountData.push({
					name: file.name,
					content: text
				});
			}

			// Store beancount data in session storage
			sessionStorage.setItem('beancountData', JSON.stringify(beancountData));
			console.log('Beancount data stored in session storage');

			// Navigate to dashboard page
			goto(resolve('/dashboard'));
		} catch (err) {
			console.error('Error during beancount processing:', err);
			error = err instanceof Error ? err.message : 'Failed to parse beancount files';
		} finally {
			isLoading = false;
		}
	}

	function handleCSVFileChange(event: Event) {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (file && file.type === 'text/csv') {
			csvFile = file;
			error = null;
		} else {
			csvFile = null;
			error = 'Please select a valid CSV file';
		}
	}

	function handleBeancountFileChange(event: Event) {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (file && (file.name.endsWith('.bean') || file.name.endsWith('.beancount'))) {
			beancountFile = file;
			error = null;
		} else {
			beancountFile = null;
			error = 'Please select a valid beancount file (.bean or .beancount)';
		}
	}

	function handleBeancountFilesChange(event: Event) {
		const target = event.target as HTMLInputElement;
		const files = target.files;
		if (files && files.length > 0) {
			beancountFiles = files;
			error = null;
		} else {
			beancountFiles = null;
			error = 'Please select valid beancount files (.bean or .beancount)';
		}
	}
</script>

<div class="min-h-screen bg-gray-50 px-4 py-12">
	<div class="mx-auto max-w-2xl">
		<div class="rounded-lg bg-white p-8 shadow-md">
			<h1 class="mb-2 text-3xl font-bold text-gray-900">Bean Import</h1>
			<p class="mb-8 text-gray-600">Transform accounting statements into beancount format</p>

			<div class="space-y-6">
				<!-- CSV File Upload -->
				<div>
					<label for="csv-file" class="mb-2 block text-sm font-medium text-gray-700">
						Accounting Statements (CSV)
					</label>
					<input
						type="file"
						id="csv-file"
						accept=".csv"
						on:change={handleCSVFileChange}
						class="block w-full text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
					/>
					{#if csvFile}
						<p class="mt-2 text-sm text-green-600">Selected: {csvFile.name}</p>
					{/if}
				</div>

				<!-- Beancount File Upload -->
				<div>
					<label for="beancount-file" class="mb-2 block text-sm font-medium text-gray-700">
						Beancount File (.bean or .beancount)
					</label>
					<input
						type="file"
						id="beancount-file"
						accept=".bean,.beancount"
						on:change={handleBeancountFileChange}
						class="block w-full text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
					/>
					{#if beancountFile}
						<p class="mt-2 text-sm text-green-600">Selected: {beancountFile.name}</p>
					{/if}
				</div>

				<!-- Beancount Files for Graphs -->
				<div>
					<label for="beancount-files" class="mb-2 block text-sm font-medium text-gray-700">
						Beancount Files for Graphs (.bean or .beancount)
					</label>
					<input
						type="file"
						id="beancount-files"
						accept=".bean,.beancount"
						multiple
						on:change={handleBeancountFilesChange}
						class="block w-full text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-green-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-green-700 hover:file:bg-green-100"
					/>
					{#if beancountFiles}
						<p class="mt-2 text-sm text-green-600">Selected {beancountFiles.length} file(s)</p>
					{/if}
				</div>

				<!-- Error Display -->
				{#if error}
					<div class="rounded-md border border-red-200 bg-red-50 p-4">
						<p class="text-sm text-red-600">{error}</p>
					</div>
				{/if}

				<!-- Start Button -->
				<div>
					<button
						on:click={handleStartImport}
						disabled={!csvFile || !beancountFile || isLoading}
						class="w-full rounded-md bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
					>
						{#if isLoading}
							Processing files...
						{:else}
							Start Import Process
						{/if}
					</button>
				</div>

				<!-- Graphs Button -->
				<div>
					<button
						on:click={handleBeancountGraphs}
						disabled={!beancountFiles || beancountFiles.length === 0 || isLoading}
						class="w-full rounded-md bg-green-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-gray-400"
					>
						{#if isLoading}
							Processing files...
						{:else}
							View Beancount Graphs
						{/if}
					</button>
				</div>

				{#if hasStoredData}
					<div class="rounded-md border border-green-200 bg-green-50 p-4">
						<p class="text-sm text-green-800">
							Previously loaded beancount data found{storedPresetCount > 0 ? ` with ${storedPresetCount} saved view(s)` : ''}.
						</p>
						<button
							on:click={() => goto(resolve('/dashboard'))}
							class="mt-3 w-full rounded-md bg-white px-4 py-2 text-sm font-semibold text-green-700 ring-1 ring-green-300 transition-colors hover:bg-green-100"
						>
							Open saved dashboard
						</button>
					</div>
				{/if}

				<!-- Instructions -->
				<div class="mt-8 rounded-md bg-blue-50 p-4">
					<h3 class="mb-2 text-sm font-semibold text-blue-900">Instructions</h3>
					<ol class="list-inside list-decimal space-y-1 text-sm text-blue-800">
						<li>Upload your accounting statements CSV file</li>
						<li>Upload your existing beancount file to extract accounts</li>
						<li>Click "Start Import Process" to begin mapping transactions</li>
						<li>Group transactions by issuer and assign them to accounts</li>
						<li>Export the mapped transactions as a new beancount file</li>
					</ol>
				</div>
			</div>
		</div>
	</div>
</div>
