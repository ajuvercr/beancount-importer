<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { BeancountAccount } from '../types';

	export let accounts: BeancountAccount[] = [];
	export let selectedAccount: string = '';
	export let placeholder: string = 'Choose an account...';
	export let id: string = 'account-select';

	let searchQuery: string = '';
	let isOpen: boolean = false;
	let filteredAccounts: BeancountAccount[] = [];
	let groupedAccounts: Map<string, BeancountAccount[]> = new Map();
	let searchInput: HTMLInputElement;

	const dispatch = createEventDispatcher();

	$: {
		// Filter accounts based on search query
		if (searchQuery.trim() === '') {
			filteredAccounts = accounts;
		} else {
			const query = searchQuery.toLowerCase();
			filteredAccounts = accounts.filter(account => 
				account.name.toLowerCase().includes(query) ||
				account.type.toLowerCase().includes(query)
			);
		}

		// Group filtered accounts by type
		groupedAccounts = new Map();
		for (const account of filteredAccounts) {
			if (!groupedAccounts.has(account.type)) {
				groupedAccounts.set(account.type, []);
			}
			groupedAccounts.get(account.type)!.push(account);
		}
	}

	function selectAccount(account: BeancountAccount) {
		selectedAccount = account.name;
		isOpen = false;
		searchQuery = '';
		dispatch('change', { account: account.name });
	}

	function toggleDropdown() {
		isOpen = !isOpen;
		if (isOpen) {
			searchQuery = '';
			// Focus search input after dropdown opens
			setTimeout(() => {
				searchInput?.focus();
			}, 0);
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			isOpen = false;
		}
	}

	// Close dropdown when clicking outside
	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.account-selector')) {
			isOpen = false;
		}
	}

	function getAccountTypeDisplayName(type: string): string {
		const typeNames: Record<string, string> = {
			'Assets': 'Assets',
			'Liabilities': 'Liabilities', 
			'Equity': 'Equity',
			'Income': 'Income',
			'Expenses': 'Expenses'
		};
		return typeNames[type] || type;
	}
</script>

<svelte:window on:click={handleClickOutside} on:keydown={handleKeydown} />

<div class="account-selector relative">
	<div class="relative">
		<input
			type="text"
			{id}
			placeholder={placeholder}
			bind:value={selectedAccount}
			on:focus={toggleDropdown}
			class="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
			readonly
		/>
		<button
			type="button"
			on:click={toggleDropdown}
			class="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
			aria-label="Toggle account dropdown"
		>
			<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>
	</div>

	{#if isOpen}
		<div class="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-64 overflow-hidden">
			<div class="p-2 border-b border-gray-200">
				<input
					type="text"
					placeholder="Search accounts..."
					bind:value={searchQuery}
					bind:this={searchInput}
					class="w-full p-2 text-sm border border-gray-200 rounded focus:ring-blue-500 focus:border-blue-500"
					on:click|stopPropagation
				/>
			</div>
			
			<div class="max-h-48 overflow-y-auto">
				{#if groupedAccounts.size > 0}
					{#each Array.from(groupedAccounts.entries()) as [type, typeAccounts]}
						<div class="account-group">
							<div class="px-3 py-2 text-xs font-semibold text-gray-500 bg-gray-50 border-b border-gray-200">
								{getAccountTypeDisplayName(type)} ({typeAccounts.length})
							</div>
							{#each typeAccounts as account}
								<button
									type="button"
									on:click={() => selectAccount(account)}
									class="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 focus:bg-gray-100 focus:outline-none border-b border-gray-100 last:border-b-0"
								>
									<div class="font-medium text-gray-900">{account.name}</div>
								</button>
							{/each}
						</div>
					{/each}
				{:else}
					<div class="px-3 py-4 text-sm text-gray-500 text-center">
						{searchQuery ? 'No accounts found matching your search' : 'No accounts available'}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.account-selector input[readonly] {
		background-color: white;
	}
	.account-selector input[readonly]:focus {
		outline: none;
	}
</style>
