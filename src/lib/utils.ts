import Papa from 'papaparse';
import { parse, format } from 'date-fns';
import type { CSVTransaction, ParsedTransaction, BeancountAccount, IssuerGroup } from './types';

export function parseCSV(file: File): Promise<ParsedTransaction[]> {
	return new Promise((resolve, reject) => {
		Papa.parse(file as any, {
			header: true,
			delimiter: ';',
			encoding: 'UTF-8',
			complete: (results) => {
				try {
					const transactions = results.data
						.filter((row: any) => row && row.Datum && row.Bedrag)
						.map((row: any, index: number) => {
							// Parse amount (handle comma as decimal separator)
							const amountStr = row.Bedrag.replace(/[.,]/g, (match: string) => match === ',' ? '.' : '');
							const amount = parseFloat(amountStr) || 0;
							
							// Parse date (DD/MM/YYYY format)
							const dateStr = row.Datum.trim();
							const date = parse(dateStr, 'dd/MM/yyyy', new Date());
							
							// Extract issuer from counterparty name or description
							const issuer = extractIssuer(row);
							
							return {
								id: `transaction-${index}`,
								accountNumber: row.Rekeningnummer?.trim() || '',
								date,
								description: row.Omschrijving?.trim() || '',
								amount: Math.abs(amount),
								credit: parseFloat(row.credit || '0') > 0,
								debit: parseFloat(row.debet || '0') > 0,
								counterpartyName: row['Naam tegenpartij']?.trim() || undefined,
								counterpartyAccount: row['rekeningnummer tegenpartij']?.trim() || undefined,
								reference: row['gestructureerde mededeling']?.trim() || row['Vrije mededeling']?.trim() || undefined,
								issuer
							};
						})
						.filter(t => !isNaN(t.date.getTime()) && t.amount > 0);
					
					resolve(transactions);
				} catch (error) {
					reject(error);
				}
			},
			error: (error) => reject(error)
		});
	});
}

function extractIssuer(row: CSVTransaction): string {
	const counterpartyName = row['Naam tegenpartij']?.trim();
	const description = row.Omschrijving?.trim();
	
	// Try to get issuer from counterparty name first
	if (counterpartyName && counterpartyName.length > 0) {
		// Clean up common patterns
		let issuer = counterpartyName.toUpperCase()
			.replace(/\s+(NV|SA|BVBA|VZW|EBVBA)\s*$/i, '') // Remove company suffixes
			.replace(/\s+(BV|GMBH|INC|LTD|LLC)\s*$/i, '')
			.replace(/[^\w\s]/g, '') // Remove special characters
			.trim();
		
		if (issuer.length > 2) {
			return issuer;
		}
	}
	
	// Fallback to description parsing
	if (description) {
		// Look for common patterns in description
		const patterns = [
			/MET\s+([A-Z0-9\s]{3,})\s+MET/i, // "MET [COMPANY] MET"
			/([A-Z0-9\s]{3,})\s+BE[0-9]/i, // "[COMPANY] BE..."
			/BETALING\s+VIA\s+\w+\s+[0-9-]+\s+[0-9-]+\s+OM\s+[0-9.]+\s+UUR\s+([A-Z0-9\s]{3,})/i,
		];
		
		for (const pattern of patterns) {
			const match = description.match(pattern);
			if (match && match[1]) {
				return match[1].trim().replace(/[^\w\s]/g, '').toUpperCase();
			}
		}
		
		// Extract first few words from description
		const words = description.split(/\s+/).slice(0, 3).join(' ');
		if (words.length > 5) {
			return words.replace(/[^\w\s]/g, '').toUpperCase();
		}
	}
	
	return 'UNKNOWN';
}

export function parseBeancountFile(content: string): BeancountAccount[] {
	const accounts: BeancountAccount[] = [];
	const lines = content.split('\n');
	
	for (const line of lines) {
		const trimmedLine = line.trim();
		// Match any date followed by "open" - more flexible pattern
		const openMatch = trimmedLine.match(/^\d{4}-\d{2}-\d{2}\s+open\s+(.+)$/);
		if (openMatch) {
			const accountName = openMatch[1].trim();
			// Remove currency suffix if present
			const cleanAccountName = accountName.replace(/\s+(EUR|USD|GBP)$/, '');
			const accountType = getAccountType(cleanAccountName);
			accounts.push({
				name: cleanAccountName,
				type: accountType
			});
		}
	}
	
	return accounts;
}

function getAccountType(accountName: string): BeancountAccount['type'] {
	const parts = accountName.split(':');
	const rootAccount = parts[0];
	
	switch (rootAccount) {
		case 'Assets':
		case 'Liabilities':
		case 'Equity':
		case 'Income':
		case 'Expenses':
			return rootAccount as BeancountAccount['type'];
		case 'Activa':
			return 'Assets';
		case 'Passiva':
			return 'Liabilities';
		case 'Vermogen':
			return 'Equity';
		case 'Inkomsten':
			return 'Income';
		case 'Uitgaven':
			return 'Expenses';
		default:
			return 'Expenses'; // Default to Expenses for unknown accounts
	}
}

export function groupTransactionsByIssuer(transactions: ParsedTransaction[]): IssuerGroup[] {
	const issuerMap: Map<string, ParsedTransaction[]> = new Map();
	
	for (const transaction of transactions) {
		if (!issuerMap.has(transaction.issuer)) {
			issuerMap.set(transaction.issuer, []);
		}
		issuerMap.get(transaction.issuer)?.push(transaction);
	}
	
	return Array.from(issuerMap.entries()).map(([issuer, transactions]) => ({
		issuer,
		transactions,
		totalAmount: transactions.reduce((sum, t) => sum + t.amount, 0)
	})).sort((a, b) => b.totalAmount - a.totalAmount);
}

export function generateBeancountFile(
	transactions: ParsedTransaction[],
	mapping: Map<string, string>,
	sourceAccount: string = 'Assets:Bank:Checking'
): string {
	const lines: string[] = [];
	
	for (const transaction of transactions) {
		const targetAccount = mapping.get(transaction.id);
		if (!targetAccount) continue;
		
		const dateStr = format(transaction.date, 'yyyy-MM-dd');
		const description = transaction.description.substring(0, 100);
		const amountStr = transaction.amount.toFixed(2).replace('.', ',');
		
		lines.push(`${dateStr} * "${description}"`);
		lines.push(`  ${sourceAccount}  ${amountStr} EUR`);
		lines.push(`  ${targetAccount}`);
		lines.push('');
	}
	
	return lines.join('\n');
}
