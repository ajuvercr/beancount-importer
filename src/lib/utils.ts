import Papa from 'papaparse';
import { parse, format } from 'date-fns';
import type { CSVTransaction, ParsedTransaction, BeancountAccount, IssuerGroup, ParsedDescription } from './types';

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
	
	// Use the comprehensive description parser
	if (description) {
		const parsed = parseTransactionDescription(description);
		
		// Use the parsed merchant name first
		if (parsed.name) {
			let issuer = parsed.name.toUpperCase()
				.replace(/\s+(NV|SA|BVBA|VZW|EBVBA)\s*$/i, '') // Remove company suffixes
				.replace(/\s+(BV|GMBH|INC|LTD|LLC)\s*$/i, '')
				.replace(/[^\w\s]/g, '') // Remove special characters
				.trim();
			
			if (issuer.length > 2) {
				return issuer;
			}
		}
		
		// Fallback to old pattern matching for backward compatibility
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

function parseTransactionDescription(description: string): ParsedDescription {
	const result: ParsedDescription = {};
	
	// Bancontact/Maestro payments: BETALING VIA BANCONTACT/Maestro XX-XX DD-MM-YYYY OM HH.MM UUR MERCHANT LOCATION MET KBC-DEBETKAART ...
	const bancontactPattern = /BETALING VIA (BANCONTACT|MAESTRO)\s+(\d{2}-\d{2})\s+(\d{2}-\d{2}-\d{4})\s+OM\s+(\d{2}\.\d{2})\s+UUR\s+(.+?)\s+(BE\d{4}\s+[A-Z\s]+|GENT|BRUGGE|BRUSSEL|ANTWERPEN)\s+MET\s+KBC-DEBETKAART[^:]*:\s*([^ ]+)/i;
	const bancontactMatch = description.match(bancontactPattern);
	if (bancontactMatch) {
		result.type = bancontactMatch[1];
		result.date = bancontactMatch[3];
		result.time = bancontactMatch[4].replace('.', ':');
		
		// Extract merchant name from the combined group (payment processor + merchant name)
		let merchantSection = bancontactMatch[5].trim();
		
		// Try to separate payment processor from actual merchant name
		// Look for patterns like "CCV*KEBAB MELITA" or "BANCONTACT*STORE NAME"
		const starMatch = merchantSection.match(/^([A-Z0-9*]{2,})\*(.+)$/i);
		if (starMatch) {
			// If there's a star, use the part after the star as merchant name
			result.name = starMatch[2].trim().replace(/\s+BE\d{0,4}\b.*/, '').trim();
		} else {
			// If no star, try to identify payment processor patterns and remove them
			const processorPatterns = /^(CCV|BANCONTACT|MAESTRO|VISA|MASTERCARD)[*]?\s*/i;
			result.name = merchantSection.replace(processorPatterns, '').trim().replace(/\s+BE\d{0,4}\b.*/, '').trim();
		}
		
		// If we still don't have a good merchant name, use the full section
		if (!result.name || result.name.length < 2) {
			result.name = merchantSection.replace(/\s+BE\d{0,4}\b.*/, '').trim();
		}
		
		result.location = bancontactMatch[6].trim();
		result.cardholderName = bancontactMatch[7].trim();
		return result;
	}
	
	// Instant transfers: INSTANTOVERSCHRIJVING VAN XX-XX BE... BANKIER OPDRACHTGEVER: BIC NAME ... OM HH.MM UUR
	if (description.includes('INSTANTOVERSCHRIJVING')) {
		result.type = 'INSTANTOVERSCHRIJVING';
		
		// Extract date
		const dateMatch = description.match(/INSTANTOVERSCHRIJVING VAN\s+(\d{2}-\d{2})\s+BE/i);
		if (dateMatch) {
			result.date = dateMatch[1] + '-2025';
		}
		
		// Extract time
		const timeMatch = description.match(/OM\s+(\d{2}\.\d{2})\s+UUR/i);
		if (timeMatch) {
			result.time = timeMatch[1].replace('.', ':');
		}
		
		// Extract merchant name - look for text after BIC code and before REFERENTIE
		const opdrachtgeverMatch = description.match(/OPDRACHTGEVER:\s+[A-Z]+.*?([A-Z0-9]+XXX)\s+(.+?)\s+REFERENTIE/i);
		if (opdrachtgeverMatch) {
			result.name = opdrachtgeverMatch[2].trim();
			result.cardholderName = opdrachtgeverMatch[2].trim();
		}
		
		if (result.name) {
			return result;
		}
	}
	
	// European domiciliations: EUROPESE DOMICILIERING XX-XX SCHULDEISER: COMPANY REF. ...
	const domiciliationPattern = /EUROPESE DOMICILIERING\s+(\d{2}-\d{2})\s+SCHULDEISER\s+:\s+([^ ]+).*?REF\.\s+SCHULDEISER:\s+([^\s]+)/i;
	const domiciliationMatch = description.match(domiciliationPattern);
	if (domiciliationMatch) {
		result.type = 'DOMICILIERING';
		result.date = domiciliationMatch[1] + '-2025'; // Assuming current year
		result.name = domiciliationMatch[2].trim();
		return result;
	}
	
	// Card settlements: AFREKENING XX-XX KBC-KREDIETKAART UITGAVENSTAAT ...
	const settlementPattern = /AFREKENING\s+(\d{2}-\d{2})\s+KBC-KREDIETKAART\s+UITGAVENSTAAT\s+(\d+)/i;
	const settlementMatch = description.match(settlementPattern);
	if (settlementMatch) {
		result.type = 'AFREKENING';
		result.date = settlementMatch[1] + '-2025'; // Assuming current year
		result.name = 'KBC-KREDIETKAART';
		return result;
	}
	
	// Regular transfers: OVERSCHRIJVING VAN XX-XX NL92... BANKIER OPDRACHTGEVER: ...
	const transferPattern = /OVERSCHRIJVING VAN\s+(\d{2}-\d{2})\s+([A-Z]{2}\d{2}\s[A-Z\s\d]+)\s+BANKIER\s+OPDRACHTGEVER:\s+([A-Z]+)/i;
	const transferMatch = description.match(transferPattern);
	if (transferMatch) {
		result.type = 'OVERSCHRIJVING';
		result.date = transferMatch[1] + '-2025'; // Assuming current year
		result.name = transferMatch[3].trim();
		return result;
	}
	
	// Fallback: try to extract any company name from description
	const companyPattern = /([A-Z][A-Z\s&-]{3,})\s+(BE\d{4}|NL\d{2}|BANKIER|SCHULDEISER|KAARTNUMMER)/i;
	const companyMatch = description.match(companyPattern);
	if (companyMatch) {
		result.name = companyMatch[1].trim();
	}
	
	return result;
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
	
	return Array.from(issuerMap.entries()).map(([issuer, transactions]) => {
		// Determine transaction type for this group
		let transactionType: string | undefined;
		
		// Try to extract transaction type from the first transaction's description
		if (transactions.length > 0) {
			const parsed = parseTransactionDescription(transactions[0].description);
			transactionType = parsed.type;
		}
		
		return {
			issuer,
			transactions,
			totalAmount: transactions.reduce((sum, t) => sum + t.amount, 0),
			transactionType
		};
	}).sort((a, b) => b.totalAmount - a.totalAmount); // Sort by total amount descending
}

export function generateTransactionDescription(transaction: ParsedTransaction): string {
	// Try to use parsed description information for better descriptions
	const parsed = parseTransactionDescription(transaction.description);
	
	if (parsed.name) {
		let description = parsed.name;
		
		// Add location if available and different from name
		if (parsed.location && parsed.location !== parsed.name) {
			description += ` (${parsed.location})`;
		}
		
		// Add transaction type if it's a payment
		if (parsed.type && (parsed.type === 'BANCONTACT' || parsed.type === 'MAESTRO')) {
			description += ` - ${parsed.type}`;
		}
		
		// If the name is too short or cryptic (less than 4 characters or all caps), 
		// add more context from the original description
		if (parsed.name.length < 4 || parsed.name === parsed.name.toUpperCase()) {
			// Try to extract more meaningful info from the original description
			const originalDesc = transaction.description;
			
			// Look for patterns that might contain more descriptive info
			const patterns = [
				// Look for anything after the merchant name in the original description
				new RegExp(parsed.name + '\\s+(.+?)\\s+(BE\\d+|GENT|BRUGGE|BRUSSEL|ANTWERPEN)', 'i'),
				// Look for anything between merchant name and location
				new RegExp('UUR\\s+' + parsed.name + '\\s+(.+?)\\s+(BE\\d+|GENT|BRUGGE|BRUSSEL|ANTWERPEN)', 'i'),
				// Look for additional context after payment type
				/.*?UUR\s+(.+?)\s+(BE\d+|GENT|BRUGGE|BRUSSEL|ANTWERPEN)/i
			];
			
			for (const pattern of patterns) {
				const match = originalDesc.match(pattern);
				if (match && match[1]) {
					const additionalInfo = match[1].trim();
					// Only add if it provides meaningful additional context
					if (additionalInfo.length > 2 && additionalInfo !== parsed.name) {
						description = `${additionalInfo} - ${parsed.name}`;
						break;
					}
				}
			}
			
			// If we still have a cryptic name, add transaction type as context
			if (parsed.name.length < 4 && parsed.type) {
				description = `${parsed.type} - ${parsed.name}`;
			}
		}
		
		return description;
	}
	
	// Fallback to counterparty name if available
	if (transaction.counterpartyName) {
		return transaction.counterpartyName;
	}
	
	// Fallback to extracting meaningful parts from description
	const originalDesc = transaction.description;
	
	// Try to extract merchant name from common patterns
	const merchantPatterns = [
		/.*?UUR\s+([A-Z0-9\s&-]{3,})\s+(BE\d+|GENT|BRUGGE|BRUSSEL|ANTWERPEN)/i,
		/.*?MET\s+([A-Z0-9\s&-]{3,})/i,
		/SCHULDEISER\s+:\s+([^ ]+)/i,
		/OPDRACHTGEVER:\s+[A-Z]+\s+([^ ]+)/i
	];
	
	for (const pattern of merchantPatterns) {
		const match = originalDesc.match(pattern);
		if (match && match[1]) {
			const merchant = match[1].trim();
			if (merchant.length > 2) {
				return merchant;
			}
		}
	}
	
	// Final fallback: first few words of description, but exclude common prefixes
	const words = originalDesc.split(/\s+/);
	const filteredWords = words.filter(word => 
		!word.match(/^(BETALING|VIA|MAESTRO|BANCONTACT|UUR|MET|OM|DEBETKAART|KAARTHOUDER)$/i)
	);
	
	const meaningfulWords = filteredWords.slice(0, 4).join(' ');
	return meaningfulWords.length > 5 ? meaningfulWords.substring(0, 50) + '...' : meaningfulWords;
}

export function generateBeancountFile(
	transactions: ParsedTransaction[],
	mapping: Map<string, string>,
	sourceAccount: string = 'Assets:Bank:Checking'
): string {
	const lines: string[] = [];
	
	// Sort transactions by date (oldest first)
	const sortedTransactions = [...transactions].sort((a, b) => {
		const dateA = a.date instanceof Date ? a.date.getTime() : new Date(a.date).getTime();
		const dateB = b.date instanceof Date ? b.date.getTime() : new Date(b.date).getTime();
		return dateA - dateB;
	});
	
	for (const transaction of sortedTransactions) {
		const targetAccount = mapping.get(transaction.id);
		if (!targetAccount) continue;
		
		const date = transaction.date instanceof Date ? transaction.date : new Date(transaction.date);
		const dateStr = format(date, 'yyyy-MM-dd');
		const description = generateTransactionDescription(transaction);
		const amountStr = transaction.amount.toFixed(2).replace('.', ',');
		
		lines.push(`${dateStr} * "${description}"`);
		
		if (transaction.credit) {
			// Money received: source account positive, target account negative
			lines.push(`  ${sourceAccount}  ${amountStr} EUR`);
			lines.push(`  ${targetAccount}  -${amountStr} EUR`);
		} else {
			// Money paid: source account negative, target account positive  
			lines.push(`  ${sourceAccount}  -${amountStr} EUR`);
			lines.push(`  ${targetAccount}  ${amountStr} EUR`);
		}
		
		lines.push('');
	}
	
	return lines.join('\n');
}

export function formatDate(date: Date): string {
	return format(date, 'dd/MM/yyyy');
}

export function formatCurrency(amount: number): string {
	return `€${amount.toFixed(2).replace('.', ',')}`;
}

export function getTransactionTypeColor(transactionType?: string): string {
	if (!transactionType) return 'border-gray-200 hover:border-gray-300 hover:bg-gray-50';
	
	switch (transactionType.toUpperCase()) {
		case 'BANCONTACT':
		case 'MAESTRO':
			return 'border-blue-200 hover:border-blue-300 hover:bg-blue-50';
		case 'INSTANTOVERSCHRIJVING':
			return 'border-green-200 hover:border-green-300 hover:bg-green-50';
		case 'DOMICILIERING':
			return 'border-purple-200 hover:border-purple-300 hover:bg-purple-50';
		case 'AFREKENING':
			return 'border-orange-200 hover:border-orange-300 hover:bg-orange-50';
		case 'OVERSCHRIJVING':
			return 'border-indigo-200 hover:border-indigo-300 hover:bg-indigo-50';
		default:
			return 'border-gray-200 hover:border-gray-300 hover:bg-gray-50';
	}
}

export function getTransactionTypeBadgeColor(transactionType?: string): string {
	if (!transactionType) return 'bg-gray-100 text-gray-700';
	
	switch (transactionType.toUpperCase()) {
		case 'BANCONTACT':
		case 'MAESTRO':
			return 'bg-blue-100 text-blue-700';
		case 'INSTANTOVERSCHRIJVING':
			return 'bg-green-100 text-green-700';
		case 'DOMICILIERING':
			return 'bg-purple-100 text-purple-700';
		case 'AFREKENING':
			return 'bg-orange-100 text-orange-700';
		case 'OVERSCHRIJVING':
			return 'bg-indigo-100 text-indigo-700';
		default:
			return 'bg-gray-100 text-gray-700';
	}
}
