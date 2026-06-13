import initSqlJs, { type Database } from 'sql.js';

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
	db: Database;
	loadBeancountData: (data: { name: string; content: string }[]) => Promise<void>;
	getAccountBalance: (account: string, includeDescendants: boolean) => Promise<number>;
	getAccountBalanceHistory: (account: string, includeDescendants: boolean) => Promise<{ date: string; balance: number }[]>;
	getAllAccounts: () => Promise<string[]>;
	getRunningAverage: (account: string, includeDescendants: boolean, windowSize?: number, startDate?: string, endDate?: string, showDailyRate?: boolean, useEMA?: boolean) => Promise<{ date: string; balance: number; runningAverage: number }[]>;
	getCashFlow: (options?: CashFlowOptions) => Promise<CashFlowResult>;
	getDateRange: () => Promise<{ start: string; end: string } | null>;
}

export interface CashFlowOptions {
	root?: string;
	maxDepth?: number;
	minAmount?: number;
	startDate?: string;
	endDate?: string;
}

export interface CashFlowLink {
	from: string;
	to: string;
	flow: number;
}

export interface CashFlowNode {
	id: string;
	label: string;
	column: number;
}

export interface CashFlowResult {
	links: CashFlowLink[];
	nodes: CashFlowNode[];
	roots: string[];
	total: number;
}

export async function createBeancountDB(): Promise<BeancountDB> {
	try {
		// Try to load SQL.js with different approaches
		let SQL;
		try {
			SQL = await initSqlJs({
				locateFile: (file) => `/${file}`
			});
		} catch (error) {
			console.warn('Failed to load SQL.js with locateFile, trying default:', error);
			SQL = await initSqlJs();
		}
		
		const db = new SQL.Database();

	// Create tables
	db.run(`
		CREATE TABLE transactions (
			id TEXT PRIMARY KEY,
			date TEXT NOT NULL,
			payee TEXT,
			narration TEXT
		)
	`);

	db.run(`
		CREATE TABLE postings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			transaction_id TEXT NOT NULL,
			account TEXT NOT NULL,
			amount REAL NOT NULL,
			currency TEXT NOT NULL DEFAULT 'EUR',
			FOREIGN KEY (transaction_id) REFERENCES transactions(id)
		)
	`);

	db.run(`
		CREATE TABLE accounts (
			name TEXT PRIMARY KEY,
			type TEXT
		)
	`);

	db.run(`
		CREATE INDEX idx_transactions_date ON transactions(date);
		CREATE INDEX idx_postings_account ON postings(account);
		CREATE INDEX idx_postings_transaction ON postings(transaction_id);
	`);

	const beancountDB: BeancountDB = {
		db,
		loadBeancountData: async (data: { name: string; content: string }[]) => {
			// Clear existing data
			db.run('DELETE FROM postings');
			db.run('DELETE FROM transactions');
			db.run('DELETE FROM accounts');

			const transactions: BeancountTransaction[] = [];
			let globalTransactionId = 0;


			for (const file of data) {
				
				const lines = file.content.split('\n');
				
				let currentTransaction: BeancountTransaction | null = null;

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const trimmedLine = line.trim();
					const originalLine = line;


					// Skip empty lines and comments
					if (!trimmedLine || trimmedLine.startsWith(';') || trimmedLine.startsWith('*') || trimmedLine.startsWith('tx')) {
						continue;
					}

					// Parse transaction header - more flexible pattern
					const transactionMatch = trimmedLine.match(/^(\d{4}-\d{2}-\d{2})\s+(?:\*\s+)?"?([^"]*)"?/);
					if (transactionMatch) {
						// Save previous transaction if exists
						if (currentTransaction) {
							// Calculate missing amounts for previous transaction
							const explicitAmounts = currentTransaction.postings.filter(p => p.amount !== 0);
							const implicitPostings = currentTransaction.postings.filter(p => p.amount === 0);
							
							if (implicitPostings.length === 1 && explicitAmounts.length > 0) {
								// Calculate the balancing amount
								const totalExplicit = explicitAmounts.reduce((sum, p) => sum + p.amount, 0);
								const balancingAmount = -totalExplicit;
								implicitPostings[0].amount = balancingAmount;
							} else if (implicitPostings.length > 1) {
								console.warn('Multiple implicit postings found, cannot calculate amounts automatically');
							}
							
							transactions.push(currentTransaction);
						}

						// Start new transaction with globally unique ID
						const [, date, description] = transactionMatch;
						const [payee, narration] = description.split(' | ').map(s => s.trim());
						
						currentTransaction = {
							id: `${file.name}_${globalTransactionId++}`, // Make ID unique across files
							date,
							payee: payee || '',
							narration: narration || description,
							postings: []
						};
						continue;
					}

					// Parse posting - more flexible pattern to handle different formats
					if (currentTransaction && (originalLine.startsWith('  ') || originalLine.match(/^\s{2,}/))) {
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
						} else {
							// Try to match posting without amount (implicit balancing posting)
							const implicitMatch = trimmedLine.match(/^(\S+)$/);
							if (implicitMatch) {
								const account = implicitMatch[1].trim();
								const posting = {
									account: account,
									amount: 0, // Will be calculated later
									currency: 'EUR'
								};
								currentTransaction.postings.push(posting);
							} else {
								// Try to extract at least the account name for debugging
								const accountMatch = trimmedLine.match(/^(\S+)/);
								if (accountMatch) {
								}
							}
						}
					} else {
						if (currentTransaction) {
						} else {
						}
					}
				}

				// Save last transaction
				if (currentTransaction) {
					// Calculate missing amounts for final transaction
					const explicitAmounts = currentTransaction.postings.filter(p => p.amount !== 0);
					const implicitPostings = currentTransaction.postings.filter(p => p.amount === 0);
					
					if (implicitPostings.length === 1 && explicitAmounts.length > 0) {
						// Calculate the balancing amount
						const totalExplicit = explicitAmounts.reduce((sum, p) => sum + p.amount, 0);
						const balancingAmount = -totalExplicit;
						implicitPostings[0].amount = balancingAmount;
					} else if (implicitPostings.length > 1) {
						console.warn('Multiple implicit postings found in final transaction, cannot calculate amounts automatically');
					}
					
					transactions.push(currentTransaction);
				}
			}

			// Sort transactions by date
			transactions.sort((a, b) => a.date.localeCompare(b.date));
			
			
			// Insert data into database
			for (const transaction of transactions) {
				
				// Insert transaction
				const stmt = db.prepare('INSERT INTO transactions (id, date, payee, narration) VALUES (?, ?, ?, ?)');
				stmt.run([transaction.id, transaction.date, transaction.payee, transaction.narration]);
				stmt.free();

				// Insert postings and collect unique accounts
				for (const posting of transaction.postings) {
					const postingStmt = db.prepare('INSERT INTO postings (transaction_id, account, amount, currency) VALUES (?, ?, ?, ?)');
					postingStmt.run([transaction.id, posting.account, posting.amount, posting.currency]);
					postingStmt.free();

					// Insert account if not exists
					const accountStmt = db.prepare('INSERT OR IGNORE INTO accounts (name) VALUES (?)');
					accountStmt.run([posting.account]);
					accountStmt.free();
				}
			}
			
			// Log final database state
			const accountResult = db.exec('SELECT COUNT(*) as count FROM accounts');
			const postingResult = db.exec('SELECT COUNT(*) as count FROM postings');
		},

		getAccountBalance: async (account: string, includeDescendants: boolean) => {
			let accountFilter = `account = ?`;
			const params = [account];

			if (includeDescendants) {
				accountFilter = `(account = ? OR account LIKE ?)`;
				params.push(`${account}:%`);
			}

			const result = db.exec(`SELECT COALESCE(SUM(amount), 0) as balance FROM postings WHERE ${accountFilter}`);
			return result[0]?.values[0]?.[0] as number || 0;
		},

		getAccountBalanceHistory: async (account: string, includeDescendants: boolean) => {
			let accountFilter = `p.account = ?`;
			let filterParams = [account];

			if (includeDescendants) {
				accountFilter = `(p.account = ? OR p.account LIKE ?)`;
				filterParams = [account, `${account}:%`];
			}

			// The filter appears twice (subquery + outer WHERE), so bind its params twice.
			const params = [...filterParams, ...filterParams];

			const result = db.exec(`
				SELECT 
					t.date,
					SUM(p.amount) as daily_change,
					(
						SELECT COALESCE(SUM(p2.amount), 0)
						FROM postings p2
						JOIN transactions t2 ON p2.transaction_id = t2.id
						WHERE t2.date <= t.date AND (${accountFilter.replaceAll('p.account', 'p2.account')})
					) as cumulative_balance
				FROM transactions t
				JOIN postings p ON t.id = p.transaction_id
				WHERE ${accountFilter}
				GROUP BY t.date
				ORDER BY t.date
			`, params);

			if (!result[0]) return [];

			return result[0].values.map((row: any[]) => ({
				date: row[0],
				balance: row[2]
			}));
		},

		getAllAccounts: async () => {
			const result = db.exec('SELECT name FROM accounts ORDER BY name');
			return result[0]?.values.map((row: any[]) => row[0]) || [];
		},

		getRunningAverage: async (account: string, includeDescendants: boolean, windowSize: number = 30, startDate?: string, endDate?: string, showDailyRate: boolean = true, useEMA: boolean = false) => {
			
			let accountFilter = `p.account = ?`;
			const params = [account];

			if (includeDescendants) {
				accountFilter = `(p.account = ? OR p.account LIKE ?)`;
				params.push(`${account}:%`);
			}


			// Calculate extended date range for window calculation
			let queryStartDate = startDate;
			let queryEndDate = endDate;
			
			if (startDate) {
				// Extend start date by windowSize days to ensure we have enough data for running average calculation
				const start = new Date(startDate);
				start.setDate(start.getDate() - windowSize);
				queryStartDate = start.toISOString().split('T')[0];
			}

			// Add date filters if provided (using extended range for proper window calculation)
			let dateFilter = '';
			if (queryStartDate && queryEndDate) {
				dateFilter = `AND t.date >= ? AND t.date <= ?`;
				params.push(queryStartDate, queryEndDate);
			} else if (queryStartDate) {
				dateFilter = `AND t.date >= ?`;
				params.push(queryStartDate);
			} else if (queryEndDate) {
				dateFilter = `AND t.date <= ?`;
				params.push(queryEndDate);
			}


			// Get daily balances with extended date range for proper window calculation
			const dailyResult = db.exec(`
				SELECT 
					t.date,
					SUM(p.amount) as daily_change
				FROM transactions t
				JOIN postings p ON t.id = p.transaction_id
				WHERE ${accountFilter} ${dateFilter}
				GROUP BY t.date
				ORDER BY t.date
			`, params);


			if (!dailyResult[0]) {
				return [];
			}

			// Calculate cumulative balance and running average in JavaScript
			const dailyData = dailyResult[0].values.map((row: any[]) => ({
				date: row[0],
				dailyChange: row[1]
			}));


			const result: { date: string; balance: number; runningAverage: number }[] = [];
			let cumulativeBalance = 0;
			let ema = 0; // For exponential moving average
			let emaAlpha = 2 / (windowSize + 1); // Smoothing factor
			let emaInitialized = false;

			for (let i = 0; i < dailyData.length; i++) {
				cumulativeBalance += dailyData[i].dailyChange;
				
				let runningAverage: number;
				
				if (useEMA) {
					// Exponential Moving Average applied to the daily changes
					if (!emaInitialized) {
						// Initialize EMA with the first few values to avoid initial spike
						const initSize = Math.min(windowSize, dailyData.length);
						const initSum = dailyData.slice(0, initSize).reduce((sum, item) => sum + item.dailyChange, 0);
						ema = initSum / initSize; // Start with SMA of initial values
						emaInitialized = true;
						
						// Apply EMA calculation for initialization period too
						for (let j = 1; j < initSize; j++) {
							ema = emaAlpha * dailyData[j].dailyChange + (1 - emaAlpha) * ema;
						}
					}
					
					// Continue EMA calculation
					ema = emaAlpha * dailyData[i].dailyChange + (1 - emaAlpha) * ema;
					runningAverage = ema;
				} else {
					// Simple Moving Average (existing logic)
					const currentDate = new Date(dailyData[i].date);
					const windowStartDate = new Date(currentDate);
					windowStartDate.setDate(windowStartDate.getDate() - windowSize + 1);
					
					// Find all data points within the time window
					const windowData = dailyData.filter((item, index) => {
						const itemDate = new Date(item.date);
						return itemDate >= windowStartDate && itemDate <= currentDate;
					});
					
					// Calculate running average of daily changes within the time window
					// Divide by windowSize (number of days), not windowData.length (number of transactions)
					const totalDailyChange = windowData.reduce((sum: number, item: { dailyChange: number }) => sum + item.dailyChange, 0);
					const dailyAverage = totalDailyChange / windowSize;
					
					runningAverage = dailyAverage;
				}
				
				// Apply the display mode: daily rate or window total
				const finalValue = showDailyRate ? runningAverage : runningAverage * windowSize;

				result.push({
					date: dailyData[i].date,
					balance: cumulativeBalance,
					runningAverage: finalValue
				});
			}


			// Now apply the original date bounds to the final result
			let filteredResult = result;
			if (startDate && endDate) {
				filteredResult = result.filter(d => d.date >= startDate && d.date <= endDate);
			} else if (startDate) {
				filteredResult = result.filter(d => d.date >= startDate);
			} else if (endDate) {
				filteredResult = result.filter(d => d.date <= endDate);
			}

			return filteredResult;
		},

		getDateRange: async () => {
			const result = db.exec('SELECT MIN(date), MAX(date) FROM transactions');
			const row = result[0]?.values[0];
			if (!row || row[0] == null) return null;
			return { start: row[0] as string, end: row[1] as string };
		},

		getCashFlow: async (options: CashFlowOptions = {}) => {
			const { root = '', maxDepth = 0, minAmount = 0, startDate, endDate } = options;
			const params: string[] = [];
			let dateFilter = '';
			if (startDate && endDate) {
				dateFilter = 'WHERE t.date >= ? AND t.date <= ?';
				params.push(startDate, endDate);
			} else if (startDate) {
				dateFilter = 'WHERE t.date >= ?';
				params.push(startDate);
			} else if (endDate) {
				dateFilter = 'WHERE t.date <= ?';
				params.push(endDate);
			}

			const result = db.exec(
				`SELECT p.account, SUM(p.amount) as net
				 FROM postings p
				 JOIN transactions t ON p.transaction_id = t.id
				 ${dateFilter}
				 GROUP BY p.account`,
				params
			);

			const empty: CashFlowResult = { links: [], nodes: [], roots: [], total: 0 };
			if (!result[0]) return empty;

			const rootSegs = root ? root.split(':').length : 0;
			const maxSegs = maxDepth > 0 ? rootSegs + maxDepth : Infinity;

			// Walk each account's hierarchy and accumulate its net amount onto every
			// parent→child edge along the path. The result is a tree (a DAG by
			// construction) where each edge's width equals the total flowing through
			// that subtree — e.g. Uitgaven:Eten → Uitgaven:Eten:Frietjes.
			const edges = new Map<string, number>();
			let total = 0;

			for (const row of result[0].values as [string, number][]) {
				const account = row[0];
				const value = Math.abs(row[1]);
				if (value === 0) continue;
				if (root && account !== root && !account.startsWith(root + ':')) continue;

				const segs = account.split(':');
				// First edge starts just below the root (or at the top level).
				const startIdx = Math.max(rootSegs, 1);
				let counted = false;
				for (let i = startIdx; i < segs.length && i <= maxSegs; i++) {
					const from = segs.slice(0, i).join(':');
					const to = segs.slice(0, i + 1).join(':');
					const key = `${from}\u0000${to}`;
					edges.set(key, (edges.get(key) || 0) + value);
					counted = true;
				}
				if (counted) total += value;
			}

			const out: CashFlowLink[] = [];
			const nodeIds = new Set<string>();
			for (const [key, flow] of edges) {
				if (flow < minAmount) continue;
				const [from, to] = key.split('\u0000');
				out.push({ from, to, flow: Math.round(flow * 100) / 100 });
				nodeIds.add(from);
				nodeIds.add(to);
			}
			out.sort((a, b) => b.flow - a.flow);

			const nodes: CashFlowNode[] = [...nodeIds].map((id) => {
				const segs = id.split(':');
				return { id, label: segs[segs.length - 1], column: segs.length - rootSegs };
			});
			const roots = [...new Set(out.map((l) => l.from))].filter(
				(f) => !out.some((l) => l.to === f)
			);

			return { links: out, nodes, roots, total: Math.round(total * 100) / 100 };
		}
	};

	return beancountDB;
	} catch (error) {
		console.error('Failed to initialize beancount database:', error);
		throw new Error(`Failed to initialize database: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
}
