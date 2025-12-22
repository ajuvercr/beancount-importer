<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import type { BeancountAccount, IssuerGroup, ParsedTransaction } from '$lib/types';
	import {
		parseCSV,
		parseBeancountFile,
		generateBeancountFile,
		groupTransactionsByIssuer,
		formatDate,
		formatCurrency,
		getTransactionTypeColor,
		getTransactionTypeBadgeColor
	} from '$lib/utils';

	let accountListRef: HTMLDivElement;
	let issuerGroupsRef: HTMLDivElement;

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
	
	// Undo functionality
	interface UndoAction {
		type: 'map';
		transactionIds: string[];
		account: string;
		timestamp: number;
	}
	
	let undoHistory: UndoAction[] = [];
	let maxUndoHistory = 50;

	// Global key handler for all keyboard navigation
	function handleGlobalKeydown(e: KeyboardEvent) {
		// Handle Shift+Arrow keys for issuer group navigation
		if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
			if (!selectedIssuer) return;
			e.preventDefault();
			const currentIndex = issuerGroups.findIndex(group => group.issuer === selectedIssuer?.issuer);
			
			if (e.key === 'ArrowUp' && currentIndex > 0) {
				// Go to previous issuer group
				selectIssuerGroup(issuerGroups[currentIndex - 1]);
			} else if (e.key === 'ArrowDown' && currentIndex < issuerGroups.length - 1) {
				// Go to next issuer group
				selectIssuerGroup(issuerGroups[currentIndex + 1]);
			}
			return;
		}

		// Handle Enter key for mapping
		if (e.key === 'Enter') {
			if (!selectedIssuer) return;
			e.preventDefault();
			if (selectedAccount && checkedTransactions.size > 0) {
				mapTransactions();
			}
			return;
		}

		// Handle arrow key navigation between search and account list
		if (e.key === 'ArrowDown' && document.activeElement === searchInput) {
			e.preventDefault();
			// Focus and select first account in list
			const firstAccount = accountListRef?.querySelector('input[type="radio"]') as HTMLInputElement;
			if (firstAccount) {
				selectedAccount = firstAccount.value;
				firstAccount.focus();
			}
			return;
		}

		// Handle arrow key navigation within account list
		if (accountListRef?.contains(document.activeElement) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
			const allRadioButtons = Array.from(accountListRef.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
			const currentIndex = allRadioButtons.indexOf(e.target as HTMLInputElement);
			
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (currentIndex === 0) {
					// At first radio button, go to search field
					selectedAccount = '';
					if (searchInput) {
						searchInput.focus();
						searchInput.select();
					}
				} else if (currentIndex > 0) {
					// Move to previous radio button
					const prevButton = allRadioButtons[currentIndex - 1];
					if (prevButton) {
						selectedAccount = prevButton.value;
						prevButton.focus();
					}
				}
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				if (currentIndex < allRadioButtons.length - 1) {
					// Move to next radio button
					const nextButton = allRadioButtons[currentIndex + 1];
					if (nextButton) {
						selectedAccount = nextButton.value;
						nextButton.focus();
					}
				}
			}
			return;
		}

		// Handle ArrowDown from search input when no account selected
		if (e.key === 'ArrowDown' && document.activeElement === searchInput && filteredAccounts.length === 1 && !selectedAccount && selectedIssuer) {
			e.preventDefault();
			selectedAccount = filteredAccounts[0].name;
			// Focus the first account for visual feedback
			const firstAccount = accountListRef?.querySelector('input[type="radio"]') as HTMLInputElement;
			if (firstAccount) {
				firstAccount.focus();
			}
		}
	}

	onMount(async () => {
		// Add global key event listener
		document.addEventListener('keydown', handleGlobalKeydown);
		
		// Load data from session storage
		const storedTransactions = sessionStorage.getItem('transactions');
		const storedAccounts = sessionStorage.getItem('accounts');

		if (!storedTransactions || !storedAccounts) {
			goto('/');
			return;
		}

		// Parse and set data - session storage contains JSON data, not raw file content
		const parsedTransactions = JSON.parse(storedTransactions);
		const parsedAccounts = JSON.parse(storedAccounts);
		
		// Debug the raw session storage data
		console.log('Raw stored transactions type:', typeof storedTransactions);
		console.log('Raw stored accounts type:', typeof storedAccounts);
		console.log('Parsed transactions type:', typeof parsedTransactions);
		console.log('Parsed accounts type:', typeof parsedAccounts);
		
		// Debug logging
		console.log('Parsed transactions count:', parsedTransactions.length);
		console.log('Parsed accounts count:', parsedAccounts.length);
		
		transactions = parsedTransactions;
		accounts = parsedAccounts;
		remainingTransactions = [...parsedTransactions];
		
		// Force reactive update by explicitly setting filteredAccounts
		filteredAccounts = parsedAccounts;
		
		updateIssuerGroups();
		
		console.log('Data assignment complete - transactions:', transactions.length, 'accounts:', accounts.length);
	});

	onDestroy(() => {
		// Clean up global key event listener
		document.removeEventListener('keydown', handleGlobalKeydown);
	});

	function updateIssuerGroups() {
		issuerGroups = groupTransactionsByIssuer(remainingTransactions);
	}

	function selectIssuerGroup(group: IssuerGroup) {
		selectedIssuer = group;
		selectedAccount = '';
		accountSearchQuery = ''; // Clear search query when changing issuer
		// Preselect all transactions for this issuer
		const newChecked = new Set<string>();
		group.transactions.forEach(t => newChecked.add(t.id));
		checkedTransactions = newChecked;
		
		// Scroll the selected issuer into view
		setTimeout(() => {
			const selectedButton = issuerGroupsRef?.querySelector(`button[data-issuer="${group.issuer}"]`) as HTMLButtonElement;
			if (selectedButton) {
				selectedButton.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			}
			
			// Focus the search input after selecting issuer
			if (searchInput) {
				searchInput.focus();
				searchInput.select();
			}
		}, 50);
	}

	function mapTransactions() {
		if (!selectedIssuer || !selectedAccount) return;

		// Get only checked transactions
		const transactionsToMap = selectedIssuer.transactions.filter((t) =>
			checkedTransactions.has(t.id)
		);

		if (transactionsToMap.length === 0) return;

		// Debug logging
		console.log('mapTransactions called:');
		console.log('- selectedIssuer:', selectedIssuer.issuer);
		console.log('- selectedAccount:', selectedAccount);
		console.log('- transactionsToMap:', transactionsToMap.length);
		console.log('- issuerGroups before mapping:', issuerGroups.length);

		// Record undo action before mapping
		const undoAction: UndoAction = {
			type: 'map',
			transactionIds: transactionsToMap.map(t => t.id),
			account: selectedAccount,
			timestamp: Date.now()
		};
		
		// Add to undo history
		undoHistory = [...undoHistory, undoAction].slice(-maxUndoHistory);

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

		// Get the current issuer index BEFORE updating issuer groups
		const currentIndex = issuerGroups.findIndex(group => group.issuer === selectedIssuer?.issuer);
		console.log('- currentIndex before update:', currentIndex);
		
		// Update issuer groups
		updateIssuerGroups();
		
		// Debug logging after update
		console.log('- issuerGroups after update:', issuerGroups.length);
		console.log('- remainingTransactions:', remainingTransactions.length);
		console.log('- mapping.size after mapping:', mapping.size);
		
		// Auto-advance to next issuer if available
		if (issuerGroups.length > 0) {
			// Clear search query before advancing
			accountSearchQuery = '';
			
			// Calculate next index based on original position
			let nextIndex;
			if (currentIndex >= 0) {
				// If the issuer was removed, the next issuer takes its position
				nextIndex = currentIndex < issuerGroups.length ? currentIndex : 0;
			} else {
				// Fallback to first if something went wrong
				nextIndex = 0;
			}
			
			console.log('- nextIndex:', nextIndex);
			console.log('- next issuer:', issuerGroups[nextIndex]?.issuer);
			
			// Select the next issuer group (or wrap to first if at end)
			selectIssuerGroup(issuerGroups[nextIndex]);
			
			// Focus the search input after a short delay to ensure DOM is updated
			setTimeout(() => {
				if (searchInput) {
					searchInput.focus();
					searchInput.select();
				}
			}, 100);
		} else {
			// No more issuers, clear selection
			selectedIssuer = null;
			selectedAccount = '';
			accountSearchQuery = '';
		}
	}

	function undoLastAction() {
		if (undoHistory.length === 0) return;
		
		const lastAction = undoHistory[undoHistory.length - 1];
		
		if (lastAction.type === 'map') {
			// Unmap the transactions
			for (const transactionId of lastAction.transactionIds) {
				mapping.delete(transactionId);
			}
			
			// Find the transactions and add them back to remaining
			const unmappedTransactions = transactions.filter(t => 
				lastAction.transactionIds.includes(t.id)
			);
			
			remainingTransactions = [...remainingTransactions, ...unmappedTransactions];
			
			// Update issuer groups
			updateIssuerGroups();
			
			// Remove from undo history
			undoHistory = undoHistory.slice(0, -1);
			
			// Select the issuer group that contains the unmapped transactions
			if (unmappedTransactions.length > 0) {
				const issuerGroup = issuerGroups.find(group => 
					group.transactions.some(t => unmappedTransactions.some(ut => ut.id === t.id))
				);
				if (issuerGroup) {
					selectIssuerGroup(issuerGroup);
				}
			}
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

	// Reactive statement to filter accounts based on search query and auto-select when only one account
	$: {
		console.log('Reactive statement running - accounts.length:', accounts.length, 'searchQuery:', accountSearchQuery);
		if (accountSearchQuery.trim() === '') {
			filteredAccounts = accounts;
			selectedAccount = ''; // Clear selection when query is empty
		} else {
			const query = accountSearchQuery.trim();
			
			// Filter accounts that match the query
			const matchingAccounts = accounts.filter(account => 
				fuzzyMatch(query, account.name) ||
				fuzzyMatch(query, account.type)
			);
			
			// Sort by fuzzy score (higher score = more relevant)
			filteredAccounts = matchingAccounts
				.map(account => ({
					account,
					score: Math.max(
						fuzzyScore(query, account.name),
						fuzzyScore(query, account.type)
					)
				}))
				.sort((a, b) => b.score - a.score)
				.map(item => item.account);
			
			// Auto-select first account when typing a query
			if (filteredAccounts.length > 0 && selectedIssuer) {
				selectedAccount = filteredAccounts[0].name;
			} else {
				selectedAccount = '';
			}
		}
		
		console.log('filteredAccounts.length after filtering:', filteredAccounts.length);
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

	function getCreditDebitColor(isCredit: boolean): string {
		return isCredit ? 'text-green-600' : 'text-red-600';
	}

	function getCreditDebitPrefix(isCredit: boolean): string {
		return isCredit ? '+' : '-';
	}

	function getIssuerGroupAmountColor(group: IssuerGroup): string {
		// Determine if this group is mostly credits or debits
		const creditCount = group.transactions.filter(t => t.credit).length;
		const debitCount = group.transactions.filter(t => !t.credit).length;
		
		// If mostly credits (money received), use green; if mostly debits (money paid), use red
		return creditCount > debitCount ? 'text-green-600' : 'text-red-600';
	}

	function fuzzyMatch(query: string, text: string): boolean {
		// Remove non-alphanumeric characters and convert to lowercase
		const cleanQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '');
		const cleanText = text.toLowerCase().replace(/[^a-z0-9]/g, '');
		
		// If query is empty, return true
		if (cleanQuery.length === 0) return true;
		
		// Check if all characters from query appear in order in text
		let queryIndex = 0;
		for (let i = 0; i < cleanText.length && queryIndex < cleanQuery.length; i++) {
			if (cleanText[i] === cleanQuery[queryIndex]) {
				queryIndex++;
			}
		}
		
		// Return true if all query characters were found in order
		return queryIndex === cleanQuery.length;
	}

	function fuzzyScore(query: string, text: string): number {
		// Remove non-alphanumeric characters and convert to lowercase
		const cleanQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '');
		const cleanText = text.toLowerCase().replace(/[^a-z0-9]/g, '');
		
		// If query is empty, return 0 (no score)
		if (cleanQuery.length === 0) return 0;
		
		// Calculate fuzzy score based on:
		// 1. Exact match bonus
		// 2. Starting match bonus  
		// 3. Sequential character matches
		// 4. Character proximity
		
		let score = 0;
		let queryIndex = 0;
		let lastMatchIndex = -1;
		
		// Exact match gets highest score
		if (cleanText === cleanQuery) {
			return 1000;
		}
		
		// Starting match gets high bonus
		if (cleanText.startsWith(cleanQuery)) {
			score += 500;
		}
		
		// Sequential character matching
		for (let i = 0; i < cleanText.length && queryIndex < cleanQuery.length; i++) {
			if (cleanText[i] === cleanQuery[queryIndex]) {
				queryIndex++;
				
				// Bonus for consecutive matches
				if (lastMatchIndex === i - 1) {
					score += 10;
				} else {
					// Penalty for gaps between matches
					const gap = i - lastMatchIndex;
					score += Math.max(1, 10 - gap);
				}
				
				lastMatchIndex = i;
			}
		}
		
		// If all characters matched, add completion bonus
		if (queryIndex === cleanQuery.length) {
			score += 100;
			
			// Bonus for shorter text (higher relevance)
			score += Math.max(0, 50 - cleanText.length);
		}
		
		return score;
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
					{#if undoHistory.length > 0}
						<button
							on:click={undoLastAction}
							class="rounded-md bg-orange-600 px-6 py-2 font-semibold text-white transition-colors hover:bg-orange-700"
						>
							Undo Last ({undoHistory.length})
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
					<div class="max-h-96 space-y-2 overflow-y-auto" aria-labelledby="issuer-groups" bind:this={issuerGroupsRef}>
						{#each issuerGroups as group}
							<button
								data-issuer={group.issuer}
								on:click={() => selectIssuerGroup(group)}
								class="w-full rounded-md border p-3 text-left transition-colors {selectedIssuer?.issuer ===
								group.issuer
									? 'border-blue-500 bg-blue-50'
									: getTransactionTypeColor(group.transactionType)}"
							>
								<div class="flex items-center justify-between">
									<div class="font-medium text-gray-900">{group.issuer}</div>
									{#if group.transactionType}
										<span class="rounded-full px-2 py-1 text-xs font-medium {getTransactionTypeBadgeColor(group.transactionType)}">
											{group.transactionType}
										</span>
									{/if}
								</div>
								<div class="text-sm text-gray-600">
									{group.transactions.length} transactions • <span class="{getIssuerGroupAmountColor(group)}">{formatCurrency(group.totalAmount)}</span>
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
							<div class="max-h-96 overflow-y-auto rounded-md border border-gray-300 bg-white" bind:this={accountListRef}>
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
								<div class="mt-4">
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
								</div>
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
													<div class="font-semibold {getCreditDebitColor(transaction.credit)}">
														{getCreditDebitPrefix(transaction.credit)}{formatCurrency(transaction.amount)}
													</div>
													<div class="text-xs font-medium {getCreditDebitColor(transaction.credit)}">
														{transaction.credit ? 'Received' : 'Paid'}
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
