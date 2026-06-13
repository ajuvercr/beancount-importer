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
- **Analytics Dashboard**: Explore your accounts with interactive charts (see below)

## Dashboard

The dashboard (`/dashboard`) turns a loaded Beancount file into interactive
charts. Everything runs in the browser via an in-memory SQLite database
(`sql.js` / WebAssembly), and the last-loaded files plus your saved views
persist in `localStorage`, so re-opening the dashboard restores your setup.
Re-upload an updated Beancount file to refresh every chart with new data.

### Balance & Trends

- **Balance line** — the running cumulative total of the account's postings
  over time (steeper slope = faster spending).
- **Daily Rate line** — a moving average of daily change over a configurable
  window (SMA or EMA), shown as €/day or as a per-window total.
- **Include sub-accounts** — roll up an account's whole subtree (e.g.
  `Uitgaven:Eten` includes `Uitgaven:Eten:Frietjes`). Matches true descendants
  only, never prefix-siblings like `Uitgaven:Etentje`.
- **Drag to inspect** — drag across the chart to highlight a date range and list
  every transaction inside it (sortable by biggest amount or by date) — handy for
  finding out what caused a spike.

### Cash Flow (Hierarchy)

A Sankey/alluvial diagram that splits a chosen account into its sub-accounts.
Each link's width is the total amount flowing into that sub-tree for the
selected period, laid out as a strict left-to-right hierarchy (a DAG).

### Compare / diff

Tick **Compare with another period** to plot the *difference* between the
current range and an earlier/later baseline of the **same width**:

- The baseline is defined by a **start date** only; its end is derived to match
  the current range width.
- Use the **−1y / −1m / +1m / +1y** steppers to slide the baseline while keeping
  its width — e.g. compare this year against last year.
- Comparing a period against itself yields a flat line at zero. In Trends the
  charts show **Δ Balance / Δ Daily rate**; in Cash Flow the Sankey is colored
  **red (more) / green (less)**.

### Saved views & date ranges

- **Quick ranges**: This month, Last month, Last 3 months, YTD, This year,
  Last year, All time, plus **−1y / −1m / +1m / +1y** window steppers.
- **Presets**: save the full dashboard configuration (account, settings, date
  range) by name and re-apply it later from the sidebar.
- **Zoom/pan**: Ctrl/⌘ + scroll to zoom either chart; drag to pan.

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
- **sql.js**: In-browser SQLite (WebAssembly) powering the dashboard queries
- **Chart.js** + **chartjs-chart-sankey**: Trends and cash-flow visualizations
- **DuckDuckGo API**: Dynamic merchant information lookup

## License

MIT License - see LICENSE file for details
