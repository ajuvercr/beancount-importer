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
	let isGenerating = false;

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
		transactions = transactions.map(t => ({
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
	}

	function mapTransactions() {
		if (!selectedIssuer || !selectedAccount) return;

		// Store transactions before nullifying selectedIssuer
		const transactionsToMap = selectedIssuer.transactions;

		// Map all transactions from this issuer to the selected account
		for (const transaction of transactionsToMap) {
			mapping.set(transaction.id, selectedAccount);
		}

		// Remove mapped transactions from remaining
		remainingTransactions = remainingTransactions.filter(
			t => !transactionsToMap.some(st => st.id === t.id)
		);

		// Reset selection
		selectedIssuer = null;
		selectedAccount = '';

		// Update issuer groups
		updateIssuerGroups();
	}

	function mapIndividualTransaction(transaction: ParsedTransaction, account: string) {
		mapping.set(transaction.id, account);
		
		// Remove from remaining transactions
		remainingTransactions = remainingTransactions.filter(t => t.id !== transaction.id);
		
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

<div class="min-h-screen bg-gray-50 py-8 px-4">
	<div class="max-w-7xl mx-auto">
		<!-- Header -->
		<div class="bg-white rounded-lg shadow-md p-6 mb-6">
			<div class="flex justify-between items-center">
				<div>
					<h1 class="text-2xl font-bold text-gray-900">Import Transactions</h1>
					<p class="text-gray-600 mt-1">
						{remainingTransactions.length} of {transactions.length} transactions remaining
					</p>
				</div>
				<div class="flex space-x-4">
					{#if mapping.size > 0}
						<button
							on:click={generateAndDownload}
							disabled={isGenerating}
							class="bg-green-600 text-white px-6 py-2 rounded-md font-semibold hover:bg-green-700 disabled:bg-gray-400 transition-colors"
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
						class="bg-gray-600 text-white px-6 py-2 rounded-md font-semibold hover:bg-gray-700 transition-colors"
					>
						Back to Home
					</button>
				</div>
			</div>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
			<!-- Issuer Groups -->
			<div class="lg:col-span-1">
				<div class="bg-white rounded-lg shadow-md p-6">
					<h2 class="text-lg font-semibold text-gray-900 mb-4" id="issuer-groups">Issuer Groups</h2>
					<div class="space-y-2 max-h-96 overflow-y-auto" aria-labelledby="issuer-groups">
						{#each issuerGroups as group}
							<button
								on:click={() => selectIssuerGroup(group)}
								class="w-full text-left p-3 rounded-md border transition-colors {
									selectedIssuer?.issuer === group.issuer
										? 'border-blue-500 bg-blue-50'
										: 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
								}"
							>
								<div class="font-medium text-gray-900">{group.issuer}</div>
								<div class="text-sm text-gray-600">
									{group.transactions.length} transactions • {formatCurrency(group.totalAmount)}
								</div>
							</button>
						{/each}
						{#if issuerGroups.length === 0}
							<p class="text-gray-500 text-center py-4">No remaining transactions</p>
						{/if}
					</div>
				</div>
			</div>

			<!-- Transaction Details and Mapping -->
			<div class="lg:col-span-2">
				{#if selectedIssuer}
					<div class="bg-white rounded-lg shadow-md p-6">
						<h2 class="text-lg font-semibold text-gray-900 mb-4">
							Map {selectedIssuer.issuer} Transactions
						</h2>
						
						<!-- Account Selection -->
						<div class="mb-6">
							<label for="bulk-account-select" class="block text-sm font-medium text-gray-700 mb-2">
								Select Account for All {selectedIssuer?.transactions.length || 0} Transactions
							</label>
							<AccountSelector
								id="bulk-account-select"
								accounts={accounts}
								bind:selectedAccount={selectedAccount}
								placeholder="Search for an account..."
							/>
							<button
								on:click={mapTransactions}
								disabled={!selectedAccount}
								class="mt-2 w-full bg-blue-600 text-white py-2 px-4 rounded-md font-semibold hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
							>
								Map All {selectedIssuer?.transactions.length || 0} Transactions to {selectedAccount || '...'}
							</button>
						</div>

						<!-- Individual Transactions -->
						<div class="space-y-3 max-h-96 overflow-y-auto">
								<h3 class="text-sm font-medium text-gray-700" id="individual-transactions">Individual Transactions</h3>
							{#each selectedIssuer.transactions as transaction}
								<div class="border border-gray-200 rounded-md p-4">
									<div class="flex justify-between items-start mb-2">
										<div class="flex-1">
											<div class="font-medium text-gray-900">{formatDate(transaction.date)}</div>
											<div class="text-sm text-gray-600">{transaction.description}</div>
											{#if transaction.counterpartyName}
												<div class="text-sm text-gray-500">Counterparty: {transaction.counterpartyName}</div>
											{/if}
										</div>
										<div class="text-right">
											<div class="font-semibold text-gray-900">{formatCurrency(transaction.amount)}</div>
											<div class="text-xs text-gray-500">
												{transaction.credit ? 'Credit' : 'Debit'}
											</div>
										</div>
									</div>
									<AccountSelector
										accounts={accounts}
										selectedAccount={getIndividualSelection(transaction.id)}
										on:change={(e) => {
											if (e.detail.account) {
												setIndividualSelection(transaction.id, e.detail.account);
												mapIndividualTransaction(transaction, e.detail.account);
											}
										}}
										placeholder="Map individually..."
										id="individual-{transaction.id}"
									/>
								</div>
							{/each}
						</div>
					</div>
				{:else}
					<div class="bg-white rounded-lg shadow-md p-6">
						<h2 class="text-lg font-semibold text-gray-900 mb-4">Select an Issuer Group</h2>
						<p class="text-gray-600">
							Choose an issuer group from the left panel to start mapping transactions to your beancount accounts.
						</p>
						{#if issuerGroups.length === 0}
							<div class="mt-6 p-4 bg-green-50 border border-green-200 rounded-md">
								<p class="text-green-800 font-medium">All transactions have been mapped!</p>
								<p class="text-green-700 text-sm mt-1">
									You can now download your beancount file with {mapping.size} imported transactions.
								</p>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		<!-- Debug Information -->
		<div class="bg-white rounded-lg shadow-md p-6 mt-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-4">Debug Information</h2>
			<div class="space-y-4">
				<div>
					<h3 class="text-sm font-medium text-gray-700 mb-2">Accounts ({accounts.length})</h3>
					<div class="bg-gray-50 rounded-md p-3 max-h-48 overflow-y-auto">
						{#if accounts.length > 0}
							<div class="space-y-1">
								{#each accounts as account}
									<div class="text-sm">
										<span class="font-medium">{account.name}</span>
										<span class="text-gray-500 ml-2">({account.type})</span>
									</div>
								{/each}
							</div>
						{:else}
							<p class="text-sm text-red-600">No accounts found - beancount file may not have been parsed correctly</p>
						{/if}
					</div>
				</div>
				
				<div>
					<h3 class="text-sm font-medium text-gray-700 mb-2">Transactions ({transactions.length})</h3>
					<div class="bg-gray-50 rounded-md p-3 max-h-32 overflow-y-auto">
						<p class="text-sm text-gray-600">
							First 3 transactions: {transactions.slice(0, 3).map(t => `${t.issuer}: ${t.description}`).join(' | ')}
						</p>
					</div>
				</div>
				
				<div>
					<h3 class="text-sm font-medium text-gray-700 mb-2">Session Storage Check</h3>
					<div class="bg-gray-50 rounded-md p-3">
						<p class="text-sm text-gray-600">
							Stored accounts: {sessionStorage.getItem('accounts') ? 'Yes' : 'No'}<br>
							Stored transactions: {sessionStorage.getItem('transactions') ? 'Yes' : 'No'}
						</p>
					</div>
				</div>
			</div>
		</div>

		<!-- Progress Summary -->
		<div class="bg-white rounded-lg shadow-md p-6 mt-6">
			<h2 class="text-lg font-semibold text-gray-900 mb-4">Import Progress</h2>
			<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
				<div class="text-center p-4 bg-gray-50 rounded-md">
					<div class="text-2xl font-bold text-gray-900">{transactions.length}</div>
					<div class="text-sm text-gray-600">Total Transactions</div>
				</div>
				<div class="text-center p-4 bg-blue-50 rounded-md">
					<div class="text-2xl font-bold text-blue-600">{mapping.size}</div>
					<div class="text-sm text-blue-600">Mapped Transactions</div>
				</div>
				<div class="text-center p-4 bg-orange-50 rounded-md">
					<div class="text-2xl font-bold text-orange-600">{remainingTransactions.length}</div>
					<div class="text-sm text-orange-600">Remaining Transactions</div>
				</div>
			</div>
		</div>
	</div>
</div>
