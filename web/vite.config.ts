import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

// BASE_PATH = "/<repo-name>/" for a GitHub Pages project site (set by the deploy workflow).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: process.env.BASE_PATH ?? '/',
  plugins: [preact()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { host: true, port: 5173 },
});
