#!/usr/bin/env node
// Builds the offline desktop app: the shared interface as static files, the bundled map data,
// and an Electron shell that stores the atlas in a local folder.
//   node desktop/build.mjs [--arch=arm64|x64|universal] [--platform=darwin|win32|linux] [--skip-package]
// Run `npm run build` first; its packed map data in dist/client/data is copied into the app.
// ATLAS_DESKTOP_OUT moves the output (default: dist-desktop/) outside a synced folder.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const desktop = import.meta.dirname, project = path.join(desktop, '..');
const out = path.resolve(process.env.ATLAS_DESKTOP_OUT ?? path.join(project, 'dist-desktop'));
const option = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const platform = option('platform', process.platform), arch = option('arch', process.arch);
const manifest = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'));
const site = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
const PRODUCT = '点亮地球';

const client = path.join(project, 'dist', 'client');
if (!await stat(path.join(client, 'data', 'map-bootstrap.json')).catch(() => null)) {
  console.error('Packed map data is missing. Run `npm run build` first.');
  process.exit(1);
}
function vite(config) {
  const result = spawnSync(process.execPath, [path.join(project, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', path.join(desktop, config)],
    { cwd: project, stdio: 'inherit', env: { ...process.env, ATLAS_DESKTOP_OUT: out } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await rm(path.join(out, 'web'), { recursive: true, force: true });
await rm(path.join(out, 'app'), { recursive: true, force: true });
vite('vite.web.config.ts');
vite('vite.main.config.ts');
for (const name of ['data', 'vendor', 'favicon.svg']) await cp(path.join(client, name), path.join(out, 'web', name), { recursive: true });
await cp(path.join(desktop, 'preload.cjs'), path.join(out, 'app', 'preload.cjs'));
await writeFile(path.join(out, 'app', 'package.json'), JSON.stringify({ name: 'light-the-earth', productName: PRODUCT, version: site.version ?? manifest.version, main: 'main.mjs', type: 'module' }, null, 1) + '\n');
console.log(`Interface and map data ready in ${path.join(out, 'web')}`);
if (process.argv.includes('--skip-package')) process.exit(0);

const { packager } = await import('@electron/packager');
const icon = path.join(desktop, { darwin: 'icon.icns', win32: 'icon.ico' }[platform] ?? 'none');
await mkdir(path.join(out, 'release'), { recursive: true });
const [bundle] = await packager({
  dir: path.join(out, 'app'), out: path.join(out, 'release'), name: PRODUCT, platform, arch, overwrite: true, asar: true,
  electronVersion: manifest.devDependencies.electron.replace(/^[^\d]*/, ''), extraResource: [path.join(out, 'web')],
  appBundleId: 'site.light-the-earth.atlas', appCategoryType: 'public.app-category.travel',
  ...(await stat(icon).catch(() => null) ? { icon } : {}),
  // Not notarised: on another Mac the first launch needs right-click → Open.
  ...(platform === 'darwin' ? { osxSign: false } : {}),
  // Not code-signed either: on Windows the first launch needs SmartScreen's "More info → Run anyway".
  ...(platform === 'win32' ? { win32metadata: { ProductName: PRODUCT, FileDescription: PRODUCT, InternalName: 'light-the-earth' } } : {}),
});
if (platform === 'darwin' && process.platform === 'darwin') {
  // Apple silicon refuses unsigned code; an ad-hoc signature is enough to run locally.
  const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', path.join(bundle, `${PRODUCT}.app`)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`App written to ${bundle}`);
