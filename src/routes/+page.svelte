<script lang="ts">
	import { goto } from '$app/navigation';
	import { parseCSV, parseBeancountFile } from '$lib/utils';
	import type { ParsedTransaction, BeancountAccount } from '$lib/types';

	let csvFile: File | null = null;
	let beancountFile: File | null = null;
	let isLoading = false;
	let error: string | null = null;

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
			goto('/import');
		} catch (err) {
			console.error('Error during import:', err);
			error = err instanceof Error ? err.message : 'Failed to parse files';
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
</script>

<div class="min-h-screen bg-gray-50 py-12 px-4">
	<div class="max-w-2xl mx-auto">
		<div class="bg-white rounded-lg shadow-md p-8">
			<h1 class="text-3xl font-bold text-gray-900 mb-2">Bean Import</h1>
			<p class="text-gray-600 mb-8">Transform accounting statements into beancount format</p>

			<div class="space-y-6">
				<!-- CSV File Upload -->
				<div>
					<label for="csv-file" class="block text-sm font-medium text-gray-700 mb-2">
						Accounting Statements (CSV)
					</label>
					<input
						type="file"
						id="csv-file"
						accept=".csv"
						on:change={handleCSVFileChange}
						class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
					/>
					{#if csvFile}
						<p class="mt-2 text-sm text-green-600">Selected: {csvFile.name}</p>
					{/if}
				</div>

				<!-- Beancount File Upload -->
				<div>
					<label for="beancount-file" class="block text-sm font-medium text-gray-700 mb-2">
						Beancount File (.bean or .beancount)
					</label>
					<input
						type="file"
						id="beancount-file"
						accept=".bean,.beancount"
						on:change={handleBeancountFileChange}
						class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
					/>
					{#if beancountFile}
						<p class="mt-2 text-sm text-green-600">Selected: {beancountFile.name}</p>
					{/if}
				</div>

				<!-- Error Display -->
				{#if error}
					<div class="bg-red-50 border border-red-200 rounded-md p-4">
						<p class="text-sm text-red-600">{error}</p>
					</div>
				{/if}

				<!-- Start Button -->
				<div>
					<button
						on:click={handleStartImport}
						disabled={!csvFile || !beancountFile || isLoading}
						class="w-full bg-blue-600 text-white py-3 px-4 rounded-md font-semibold hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
					>
						{#if isLoading}
							Processing files...
						{:else}
							Start Import Process
						{/if}
					</button>
				</div>

				<!-- Instructions -->
				<div class="mt-8 p-4 bg-blue-50 rounded-md">
					<h3 class="text-sm font-semibold text-blue-900 mb-2">Instructions</h3>
					<ol class="text-sm text-blue-800 space-y-1 list-decimal list-inside">
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
