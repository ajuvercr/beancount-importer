import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// Use static adapter for GitHub Pages deployment
		adapter: adapter({
			// default options are shown. On some platforms
			// these options are set automatically — see below
			pages: 'build',
			assets: 'build',
			fallback: 'index.html', // Enable SPA mode
			precompress: false,
			strict: false // Allow dynamic routes for SPA
		}),
		paths: {
			// Set base path for GitHub Pages deployment from environment variable
			base: process.env.PUBLIC_BASE_PATH || ''
		}
	}
};

export default config;
