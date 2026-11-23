MapLibre GL JS 6.15.0 worker

maplibre-gl-worker.mjs is the unmodified official worker copied from
node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs.
It is served locally because Vite moves the main MapLibre module during
dependency optimization, invalidating its default sibling worker URL.

When upgrading maplibre-gl, copy its matching worker into a versioned folder
and update MAPLIBRE_WORKER_URL in components/EarthMap.tsx together.
The upstream BSD 3-Clause license is included as LICENSE.txt.
