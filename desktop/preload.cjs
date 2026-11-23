// Runs in the sandboxed renderer. Exposes only what lib/runtime.ts describes.
// A sandboxed preload script must be CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');
const PREFIX = '--atlas-data-directory=';
const dataDirectory = process.argv.find((value) => value.startsWith(PREFIX))?.slice(PREFIX.length) ?? '';
contextBridge.exposeInMainWorld('atlasDesktop', {
  platform: process.platform,
  dataDirectory,
  revealData: () => ipcRenderer.invoke('atlas:reveal-data').then(() => undefined),
});
