// Simple test to verify beancount parsing
const { parseBeancountFile } = require('./src/lib/utils.ts');

const testContent = `
1970-01-01 open Activa:CA:Arcky:Checking   EUR
1970-01-01 open Activa:Cash          EUR
1970-01-01 open Uitgaven:Eten          EUR
1970-01-01 open Inkomsten:Bijdrage:Arthur   EUR
`;

const accounts = parseBeancountFile(testContent);
console.log('Parsed accounts:', accounts);
console.log('Account types:', accounts.map(a => a.type));
