export interface BeancountTransaction {
	id: string;
	date: string;
	payee: string;
	narration: string;
	postings: BeancountPosting[];
}

export interface BeancountPosting {
	account: string;
	amount: number;
	currency: string;
}

export interface BeancountDB {
	loadBeancountData: (data: { name: string; content: string }[]) => Promise<void>;
	getAccountBalance: (account: string, includeDescendants: boolean) => Promise<number>;
	getAccountBalanceHistory: (account: string, includeDescendants: boolean) => Promise<{ date: string; balance: number }[]>;
	getAllAccounts: () => Promise<string[]>;
	getRunningAverage: (account: string, includeDescendants: boolean, windowSize?: number) => Promise<{ date: string; balance: number; runningAverage: number }[]>;
}

export function createBeancountDB(): BeancountDB {
	let transactions: BeancountTransaction[] = [];
	let accounts: Set<string> = new Set();

	return {
		loadBeancountData: async (data: { name: string; content: string }[]) => {
			// Clear existing data
			transactions = [];
			accounts.clear();

			console.log('Loading beancount data from', data.length, 'files');
			
			for (const file of data) {
				console.log('Processing file:', file.name, 'Content length:', file.content.length);
				console.log('First 500 chars:', file.content.substring(0, 500));
				
				const lines = file.content.split('\n');
				console.log('Total lines:', lines.length);
				
				let currentTransaction: BeancountTransaction | null = null;
				let transactionId = 0;

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const trimmedLine = line.trim();
					const originalLine = line;

					console.log(`Line ${i + 1}: "${originalLine}" (trimmed: "${trimmedLine}")`);

					// Skip empty lines and comments
					if (!trimmedLine || trimmedLine.startsWith(';') || trimmedLine.startsWith('*') || trimmedLine.startsWith('tx')) {
						console.log('Skipping line (empty/comment)');
						continue;
					}

					// Parse transaction header - more flexible pattern
					const transactionMatch = trimmedLine.match(/^(\d{4}-\d{2}-\d{2})\s+(?:\*\s+)?"?([^"]*)"?/);
					if (transactionMatch) {
						console.log('Found transaction header');
						// Save previous transaction if exists
						if (currentTransaction) {
							transactions.push(currentTransaction);
							console.log('Saved transaction:', currentTransaction);
						}

						// Start new transaction
						const [, date, description] = transactionMatch;
						const [payee, narration] = description.split(' | ').map(s => s.trim());
						
						currentTransaction = {
							id: `tx_${transactionId++}`,
							date,
							payee: payee || '',
							narration: narration || description,
							postings: []
						};
						console.log('New transaction:', currentTransaction);
						continue;
					}

					// Parse posting - more flexible pattern to handle different formats
					if (currentTransaction && (originalLine.startsWith('  ') || originalLine.match(/^\s{2,}/))) {
						console.log('Found posting line, attempting to parse:', originalLine);
						// Try multiple patterns for postings
						let postingMatch = trimmedLine.match(/^([^"]+)\s+([+-]?\d+(?:\.\d+)?)\s+(\w+)?/);
						if (!postingMatch) {
							// Try pattern without quotes around account
							postingMatch = trimmedLine.match(/^(\S+)\s+([+-]?\d+(?:\.\d+)?)\s+(\w+)?/);
						}
						if (!postingMatch) {
							// Try pattern with just account and amount
							postingMatch = trimmedLine.match(/^(\S+)\s+([+-]?\d+(?:\.\d+)?)/);
						}
						
						if (postingMatch) {
							const [, account, amount, currency] = postingMatch;
							const posting = {
								account: account.trim(),
								amount: parseFloat(amount),
								currency: currency || 'EUR'
							};
							currentTransaction.postings.push(posting);
							accounts.add(account.trim());
							console.log('Added posting:', posting);
						} else {
							console.log('Failed to match posting pattern for line:', trimmedLine);
							// Try to extract at least the account name for debugging
							const accountMatch = trimmedLine.match(/^(\S+)/);
							if (accountMatch) {
								console.log('Found account name:', accountMatch[1]);
							}
						}
					} else {
						if (currentTransaction) {
							console.log('Line not recognized as posting (wrong indentation):', originalLine);
						} else {
							console.log('Line not recognized (no current transaction):', originalLine);
						}
					}
				}

				// Save last transaction
				if (currentTransaction) {
					transactions.push(currentTransaction);
					console.log('Saved final transaction:', currentTransaction);
				}
			}

			// Sort transactions by date
			transactions.sort((a, b) => a.date.localeCompare(b.date));
			
			console.log('Final results:');
			console.log('Total transactions:', transactions.length);
			console.log('Total accounts:', accounts.size);
			console.log('Accounts:', Array.from(accounts));
		},

		getAccountBalance: async (account: string, includeDescendants: boolean) => {
			let balance = 0;
			
			for (const transaction of transactions) {
				for (const posting of transaction.postings) {
					if (includeDescendants) {
						if (posting.account === account || posting.account.startsWith(account + ':')) {
							balance += posting.amount;
						}
					} else {
						if (posting.account === account) {
							balance += posting.amount;
						}
					}
				}
			}
			
			return balance;
		},

		getAccountBalanceHistory: async (account: string, includeDescendants: boolean) => {
			const history: { date: string; balance: number }[] = [];
			let cumulativeBalance = 0;
			const dateBalances = new Map<string, number>();

			// Group transactions by date and calculate daily changes
			for (const transaction of transactions) {
				let dailyChange = 0;
				
				for (const posting of transaction.postings) {
					if (includeDescendants) {
						if (posting.account === account || posting.account.startsWith(account + ':')) {
							dailyChange += posting.amount;
						}
					} else {
						if (posting.account === account) {
							dailyChange += posting.amount;
						}
					}
				}
				
				if (dailyChange !== 0) {
					dateBalances.set(transaction.date, (dateBalances.get(transaction.date) || 0) + dailyChange);
				}
			}

			// Calculate cumulative balance over time
			const sortedDates = Array.from(dateBalances.keys()).sort();
			for (const date of sortedDates) {
				cumulativeBalance += dateBalances.get(date) || 0;
				history.push({ date, balance: cumulativeBalance });
			}

			return history;
		},

		getAllAccounts: async () => {
			return Array.from(accounts).sort();
		},

		getRunningAverage: async function(account: string, includeDescendants: boolean, windowSize: number = 30) {
			const history = await this.getAccountBalanceHistory(account, includeDescendants);
			const result: { date: string; balance: number; runningAverage: number }[] = [];

			for (let i = 0; i < history.length; i++) {
				const startIdx = Math.max(0, i - windowSize + 1);
				const windowData = history.slice(startIdx, i + 1);
				
				// Calculate running average of the balance values in the window
				const balanceSum = windowData.reduce((sum: number, item: { balance: number }) => sum + item.balance, 0);
				const average = balanceSum / windowData.length;

				result.push({
					date: history[i].date,
					balance: history[i].balance,
					runningAverage: average
				});
			}

			return result;
		}
	};
}
