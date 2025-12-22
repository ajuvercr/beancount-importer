# Bean Import - Beancount Transaction Import Tool

A modern web application for importing and categorizing bank transactions into Beancount format with dynamic merchant information lookup.

## Features

- **CSV Import**: Upload and parse bank transaction CSV files
- **Beancount Export**: Generate properly formatted Beancount files
- **Smart Transaction Parsing**: Automatically extract merchant names and transaction details
- **Dynamic Merchant Lookup**: Real-time web search for merchant information
- **Fuzzy Account Search**: Find and categorize accounts quickly
- **Keyboard Navigation**: Full keyboard support for efficient workflow
- **Undo/Redo**: Built-in undo functionality for mistake recovery

## Getting Started

### Prerequisites

- Node.js 20 or higher
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

### Development

Run the development server:
```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) to view the application.

### Building

Build for production:
```bash
npm run build
```

The static files will be generated in the `build/` directory.

## Usage

1. **Upload Files**: Upload your CSV file and existing Beancount account file
2. **Review Transactions**: Browse transactions grouped by merchant/issuer
3. **Categorize**: Assign transactions to appropriate accounts using fuzzy search
4. **Export**: Download the categorized transactions as a Beancount file

## Deployment

This project is configured for static site deployment and includes:

- **GitHub Actions**: Automatic deployment to GitHub Pages
- **Static Adapter**: Optimized for static hosting
- **Base Path Configuration**: Proper path handling for GitHub Pages

### GitHub Pages Deployment

1. Push to the `main` branch
2. GitHub Actions will automatically build and deploy to GitHub Pages
3. The site will be available at `https://[username].github.io/bean-import/`

## Technology Stack

- **SvelteKit**: Modern web framework
- **TypeScript**: Type-safe development
- **Tailwind CSS**: Utility-first CSS framework
- **Papa Parse**: CSV parsing library
- **DuckDuckGo API**: Dynamic merchant information lookup

## License

MIT License - see LICENSE file for details
