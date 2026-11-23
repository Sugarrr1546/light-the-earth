// MapLibre's official worker, plus one addition: once the map has sent it nothing for a while, it collects its
// garbage. Otherwise the parsed geometry of countries already released stays in the worker's heap (about 135 MB
// after a tour of a few countries), because an idle worker allocates nothing and V8 never gets round to it.
// The desktop app starts with --expose-gc, which gives workers gc() too; a browser has none and this does nothing.
import './maplibre-gl-6.15.0/maplibre-gl-worker.mjs';

const QUIET_MS = 20_000;
const collect = globalThis.gc;
if (typeof collect === 'function') {
  let timer;
  self.addEventListener('message', () => {
    clearTimeout(timer);
    timer = setTimeout(() => collect({ type: 'major', execution: 'sync', flavor: 'last-resort' }), QUIET_MS);
  });
}
