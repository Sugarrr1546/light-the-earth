import path from 'node:path';
import { defineConfig } from 'vite';

const project = path.join(import.meta.dirname, '..');

// Bundles the Electron main process, including the shared validation in lib/, into one file.
export default defineConfig({
  root: import.meta.dirname,
  publicDir: false,
  build: {
    ssr: path.join(import.meta.dirname, 'main.ts'),
    outDir: process.env.ATLAS_DESKTOP_OUT ? path.join(process.env.ATLAS_DESKTOP_OUT, 'app') : path.join(project, 'dist-desktop', 'app'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { external: ['electron'], output: { entryFileNames: 'main.mjs' } },
  },
  ssr: { noExternal: true },
});
