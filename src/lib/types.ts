export interface CSVTransaction {
	'Rekeningnummer': string;
	'Rubrieknaam': string;
	'Naam': string;
	'Munt': string;
	'Afschriftnummer': string;
	'Datum': string;
	'Omschrijving': string;
	'Valuta': string;
	'Bedrag': string;
	'Saldo': string;
	'credit': string;
	'debet': string;
	'rekeningnummer tegenpartij': string;
	'BIC tegenpartij': string;
	'Naam tegenpartij': string;
	'Adres tegenpartij': string;
	'gestructureerde mededeling': string;
	'Vrije mededeling': string;
}

export interface ParsedTransaction {
	id: string;
	accountNumber: string;
	date: Date;
	description: string;
	amount: number;
	credit: boolean;
	debit: boolean;
	counterpartyName?: string;
	counterpartyAccount?: string;
	reference?: string;
	issuer: string;
}

export interface BeancountAccount {
	name: string;
	type: 'Assets' | 'Liabilities' | 'Equity' | 'Income' | 'Expenses';
}

export interface ImportState {
	transactions: ParsedTransaction[];
	accounts: BeancountAccount[];
	mappedTransactions: Map<string, string>; // transactionId -> accountId
	remainingTransactions: ParsedTransaction[];
}

export interface IssuerGroup {
	issuer: string;
	transactions: ParsedTransaction[];
	totalAmount: number;
}
