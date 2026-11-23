import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const project = path.join(import.meta.dirname, '..');

// The same interface as the hosted site, bundled as static files for the desktop app.
export default defineConfig({
  root: path.join(import.meta.dirname, 'web'),
  plugins: [react()],
  resolve: { alias: { '@': project } },
  css: { postcss: project },
  build: {
    outDir: process.env.ATLAS_DESKTOP_OUT ? path.join(process.env.ATLAS_DESKTOP_OUT, 'web') : path.join(project, 'dist-desktop', 'web'),
    emptyOutDir: true,
    target: 'chrome140',
  },
});
