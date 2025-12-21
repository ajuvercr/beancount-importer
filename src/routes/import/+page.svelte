<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { groupTransactionsByIssuer, generateBeancountFile } from '$lib/utils';
	import AccountSelector from '$lib/components/AccountSelector.svelte';
	import type { ParsedTransaction, BeancountAccount, IssuerGroup } from '$lib/types';

	let transactions: ParsedTransaction[] = [];
	let accounts: BeancountAccount[] = [];
	let issuerGroups: IssuerGroup[] = [];
	let selectedIssuer: IssuerGroup | null = null;
	let selectedAccount: string = '';
	let mapping = new Map<string, string>();
	let remainingTransactions: ParsedTransaction[] = [];
	let checkedTransactions: Set<string> = new Set();
	let isGenerating = false;
	let accountSearchQuery: string = '';
	let filteredAccounts: BeancountAccount[] = [];
	let searchInput: HTMLInputElement;

	onMount(() => {
		// Load data from session storage
		const storedTransactions = sessionStorage.getItem('transactions');
		const storedAccounts = sessionStorage.getItem('accounts');

		if (!storedTransactions || !storedAccounts) {
			goto('/');
			return;
		}

		transactions = JSON.parse(storedTransactions);
		accounts = JSON.parse(storedAccounts);

		// Convert date strings back to Date objects
		transactions = transactions.map((t) => ({
			...t,
			date: new Date(t.date)
		}));

		remainingTransactions = [...transactions];
		updateIssuerGroups();
	});

	function updateIssuerGroups() {
		issuerGroups = groupTransactionsByIssuer(remainingTransactions);
	}

	function selectIssuerGroup(group: IssuerGroup) {
		selectedIssuer = group;
		selectedAccount = '';
		// Preselect all transactions for this issuer
		const newChecked = new Set<string>();
		group.transactions.forEach(t => newChecked.add(t.id));
		checkedTransactions = newChecked;
	}

	function mapTransactions() {
		if (!selectedIssuer || !selectedAccount) return;

		// Get only checked transactions
		const transactionsToMap = selectedIssuer.transactions.filter((t) =>
			checkedTransactions.has(t.id)
		);

		if (transactionsToMap.length === 0) return;

		// Map checked transactions to the selected account
		for (const transaction of transactionsToMap) {
			mapping.set(transaction.id, selectedAccount);
		}

		// Remove mapped transactions from remaining
		remainingTransactions = remainingTransactions.filter(
			(t) => !transactionsToMap.some((st) => st.id === t.id)
		);

		// Clear checked transactions
		checkedTransactions = new Set();

		// Update issuer groups
		updateIssuerGroups();
		
		// Auto-advance to next issuer if available
		if (issuerGroups.length > 0) {
			// Select the first available issuer group
			selectIssuerGroup(issuerGroups[0]);
			
			// Focus the search input after a short delay to ensure DOM is updated
			setTimeout(() => {
				if (searchInput) {
					searchInput.focus();
					searchInput.select();
				}
			}, 50);
		} else {
			// No more issuers, clear selection
			selectedIssuer = null;
			selectedAccount = '';
		}
	}

	function mapIndividualTransaction(transaction: ParsedTransaction, account: string) {
		mapping.set(transaction.id, account);

		// Remove from remaining transactions
		remainingTransactions = remainingTransactions.filter((t) => t.id !== transaction.id);

		// Update issuer groups
		updateIssuerGroups();
	}

	$: individualSelections = new Map<string, string>();

	function getIndividualSelection(transactionId: string): string {
		return individualSelections.get(transactionId) || '';
	}

	function setIndividualSelection(transactionId: string, account: string) {
		individualSelections.set(transactionId, account);
	}

	// Reactive statement to filter accounts based on search query
	$: {
		if (accountSearchQuery.trim() === '') {
			filteredAccounts = accounts;
		} else {
			const query = accountSearchQuery.toLowerCase();
			filteredAccounts = accounts.filter(account => 
				account.name.toLowerCase().includes(query) ||
				account.type.toLowerCase().includes(query)
			);
		}
	}

	async function generateAndDownload() {
		isGenerating = true;
		try {
			const beancountContent = generateBeancountFile(transactions, mapping);
			const blob = new Blob([beancountContent], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `imported-transactions-${new Date().toISOString().split('T')[0]}.bean`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} finally {
			isGenerating = false;
		}
	}

	function formatCurrency(amount: number): string {
		return new Intl.NumberFormat('nl-BE', {
			style: 'currency',
			currency: 'EUR'
		}).format(amount);
	}

	function formatDate(date: Date): string {
		return new Intl.DateTimeFormat('nl-BE').format(date);
	}

	function getAccountTypeName(type: string): string {
		return type.charAt(0).toUpperCase() + type.slice(1);
	}
</script>

<div class="min-h-screen bg-gray-50 px-4 py-8">
	<div class="mx-auto max-w-7xl">
		<!-- Header -->
		<div class="mb-6 rounded-lg bg-white p-6 shadow-md">
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-bold text-gray-900">Import Transactions</h1>
					<p class="mt-1 text-gray-600">
						{remainingTransactions.length} of {transactions.length} transactions remaining
					</p>
				</div>
				<div class="flex space-x-4">
					{#if mapping.size > 0}
						<button
							on:click={generateAndDownload}
							disabled={isGenerating}
							class="rounded-md bg-green-600 px-6 py-2 font-semibold text-white transition-colors hover:bg-green-700 disabled:bg-gray-400"
						>
							{#if isGenerating}
								Generating...
							{:else}
								Download Beancount File ({mapping.size} transactions)
							{/if}
						</button>
					{/if}
					<button
						on:click={() => goto('/')}
						class="rounded-md bg-gray-600 px-6 py-2 font-semibold text-white transition-colors hover:bg-gray-700"
					>
						Back to Home
					</button>
				</div>
			</div>
		</div>

		<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
			<!-- Issuer Groups -->
			<div class="lg:col-span-1">
				<div class="rounded-lg bg-white p-6 shadow-md">
					<h2 class="mb-4 text-lg font-semibold text-gray-900" id="issuer-groups">Issuer Groups</h2>
					<div class="max-h-96 space-y-2 overflow-y-auto" aria-labelledby="issuer-groups">
						{#each issuerGroups as group}
							<button
								on:click={() => selectIssuerGroup(group)}
								class="w-full rounded-md border p-3 text-left transition-colors {selectedIssuer?.issuer ===
								group.issuer
									? 'border-blue-500 bg-blue-50'
									: 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'}"
							>
								<div class="font-medium text-gray-900">{group.issuer}</div>
								<div class="text-sm text-gray-600">
									{group.transactions.length} transactions • {formatCurrency(group.totalAmount)}
								</div>
							</button>
						{/each}
						{#if issuerGroups.length === 0}
							<p class="py-4 text-center text-gray-500">No remaining transactions</p>
						{/if}
					</div>
				</div>
			</div>

			<!-- Account Selection -->
			<div class="lg:col-span-1">
				{#if selectedIssuer}
					<div class="rounded-lg bg-white p-6 shadow-md">
						<h2 class="mb-4 text-lg font-semibold text-gray-900">
							Select Account
						</h2>
						<fieldset>
							<legend class="mb-2 block text-sm font-medium text-gray-700">
								Search Accounts
							</legend>
							<!-- Search Input -->
							<div class="mb-2">
								<input
									type="text"
									placeholder="Search accounts..."
									bind:value={accountSearchQuery}
									bind:this={searchInput}
									class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-blue-500 focus:border-blue-500"
								/>
							</div>
							<!-- Account List -->
							<div class="max-h-96 overflow-y-auto rounded-md border border-gray-300 bg-white">
								{#each filteredAccounts as account}
									<label
										class="flex cursor-pointer items-center border-b border-gray-100 px-3 py-2 last:border-b-0 hover:bg-gray-50"
									>
										<input
											type="radio"
											name="account-selection"
											value={account.name}
											bind:group={selectedAccount}
											class="mr-3 text-blue-600 focus:ring-blue-500"
										/>
										<div>
											<div class="font-medium text-gray-900">{account.name}</div>
											<div class="text-xs text-gray-500">{account.type}</div>
										</div>
									</label>
								{/each}
								{#if filteredAccounts.length === 0}
									<div class="px-3 py-4 text-center text-sm text-gray-500">
										No accounts found matching your search
									</div>
								{/if}
							</div>
						</fieldset>
					</div>
				{:else}
					<div class="rounded-lg bg-white p-6 shadow-md">
						<h2 class="mb-4 text-lg font-semibold text-gray-900">Select an Issuer Group</h2>
						<p class="text-gray-600">
							Choose an issuer group from the left panel to start mapping transactions to your
							beancount accounts.
						</p>
						{#if issuerGroups.length === 0}
							<div class="mt-6 rounded-md border border-green-200 bg-green-50 p-4">
								<p class="font-medium text-green-800">All transactions have been mapped!</p>
								<p class="mt-1 text-sm text-green-700">
									You can now download your beancount file with {mapping.size} imported transactions.
								</p>
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Transaction Details and Mapping -->
			<div class="lg:col-span-1">
				{#if selectedIssuer}
					<div class="rounded-lg bg-white p-6 shadow-md">
						<h2 class="mb-4 text-lg font-semibold text-gray-900">
							{selectedIssuer.issuer} Transactions
						</h2>

						<!-- Map Button -->
						<div class="mb-4">
							<button
								on:click={mapTransactions}
								disabled={!selectedAccount || checkedTransactions.size === 0}
								class="w-full rounded-md bg-blue-600 px-4 py-2 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
							>
								Map {checkedTransactions.size} Checked Transaction{checkedTransactions.size !== 1
									? 's'
									: ''} to {selectedAccount || '...'}
							</button>
						</div>

						<!-- Individual Transactions -->
						<div class="max-h-96 space-y-3 overflow-y-auto">
							<div class="mb-3 flex items-center justify-between">
								<h3 class="text-sm font-medium text-gray-700" id="individual-transactions">
									Individual Transactions
								</h3>
								<div class="flex items-center space-x-2">
									<fieldset>
										<legend class="sr-only">Select All Transactions</legend>
										<input
											type="checkbox"
											id="select-all"
											checked={checkedTransactions.size === selectedIssuer?.transactions.length}
											on:change={(e) => {
												const target = e.target as HTMLInputElement;
												if (target.checked && selectedIssuer) {
													// Check all transactions
													const newChecked = new Set(checkedTransactions);
													selectedIssuer.transactions.forEach((t) => newChecked.add(t.id));
													checkedTransactions = newChecked;
												} else {
													// Uncheck all transactions
													checkedTransactions = new Set();
												}
											}}
											class="rounded text-blue-600 focus:ring-blue-500"
										/>
										<label for="select-all" class="text-sm text-gray-600">Select All</label>
									</fieldset>
								</div>
							</div>
							{#each selectedIssuer.transactions as transaction}
								<div class="rounded-md border border-gray-200 p-4">
									<div class="flex items-start space-x-3">
										<input
											type="checkbox"
											id="transaction-{transaction.id}"
											checked={checkedTransactions.has(transaction.id)}
											on:change={(e) => {
												const target = e.target as HTMLInputElement;
												const newChecked = new Set(checkedTransactions);
												if (target.checked) {
													newChecked.add(transaction.id);
												} else {
													newChecked.delete(transaction.id);
												}
												checkedTransactions = newChecked;
											}}
											class="mt-1 rounded text-blue-600 focus:ring-blue-500"
										/>
										<div class="flex-1">
											<div class="mb-2 flex items-start justify-between">
												<div class="flex-1">
													<div class="font-medium text-gray-900">
														{formatDate(transaction.date)}
													</div>
													<div class="text-sm text-gray-600">{transaction.description}</div>
													{#if transaction.counterpartyName}
														<div class="text-sm text-gray-500">
															Counterparty: {transaction.counterpartyName}
														</div>
													{/if}
												</div>
												<div class="text-right">
													<div class="font-semibold text-gray-900">
														{formatCurrency(transaction.amount)}
													</div>
													<div class="text-xs text-gray-500">
														{transaction.credit ? 'Credit' : 'Debit'}
													</div>
												</div>
											</div>
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{:else}
					<div class="rounded-lg bg-white p-6 shadow-md h-full flex items-center justify-center">
						<p class="text-gray-500 text-center">
							Select an issuer group to see transactions
						</p>
					</div>
				{/if}
			</div>
		</div>

		<!-- Debug Information -->
		<div class="mt-6 rounded-lg bg-white p-6 shadow-md">
			<h2 class="mb-4 text-lg font-semibold text-gray-900">Debug Information</h2>
			<div class="space-y-4">
				<div>
					<h3 class="mb-2 text-sm font-medium text-gray-700">Accounts ({accounts.length})</h3>
					<div class="max-h-48 overflow-y-auto rounded-md bg-gray-50 p-3">
						{#if accounts.length > 0}
							<div class="space-y-1">
								{#each accounts as account}
									<div class="text-sm">
										<span class="font-medium">{account.name}</span>
										<span class="ml-2 text-gray-500">({account.type})</span>
									</div>
								{/each}
							</div>
						{:else}
							<p class="text-sm text-red-600">
								No accounts found - beancount file may not have been parsed correctly
							</p>
						{/if}
					</div>
				</div>

				<div>
					<h3 class="mb-2 text-sm font-medium text-gray-700">
						Transactions ({transactions.length})
					</h3>
					<div class="max-h-32 overflow-y-auto rounded-md bg-gray-50 p-3">
						<p class="text-sm text-gray-600">
							First 3 transactions: {transactions
								.slice(0, 3)
								.map((t) => `${t.issuer}: ${t.description}`)
								.join(' | ')}
						</p>
					</div>
				</div>

				<div>
					<h3 class="mb-2 text-sm font-medium text-gray-700">Session Storage Check</h3>
					<div class="rounded-md bg-gray-50 p-3">
						<p class="text-sm text-gray-600">
							Stored accounts: {sessionStorage.getItem('accounts') ? 'Yes' : 'No'}<br />
							Stored transactions: {sessionStorage.getItem('transactions') ? 'Yes' : 'No'}
						</p>
					</div>
				</div>
			</div>
		</div>

		<!-- Progress Summary -->
		<div class="mt-6 rounded-lg bg-white p-6 shadow-md">
			<h2 class="mb-4 text-lg font-semibold text-gray-900">Import Progress</h2>
			<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
				<div class="rounded-md bg-gray-50 p-4 text-center">
					<div class="text-2xl font-bold text-gray-900">{transactions.length}</div>
					<div class="text-sm text-gray-600">Total Transactions</div>
				</div>
				<div class="rounded-md bg-blue-50 p-4 text-center">
					<div class="text-2xl font-bold text-blue-600">{mapping.size}</div>
					<div class="text-sm text-blue-600">Mapped Transactions</div>
				</div>
				<div class="rounded-md bg-orange-50 p-4 text-center">
					<div class="text-2xl font-bold text-orange-600">{remainingTransactions.length}</div>
					<div class="text-sm text-orange-600">Remaining Transactions</div>
				</div>
			</div>
		</div>
	</div>
</div>
