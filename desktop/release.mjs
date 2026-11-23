#!/usr/bin/env node
// One command from source to an installed desktop app, built outside the synced project folder.
//   node desktop/release.mjs [--install] [--quit] [--open] [--skip-tests] [--allow-download]
//     --install         put the app in /Applications (ATLAS_INSTALL_PATH to change), replacing the old one
//     --quit            if the app is open, ask it to quit first (an unsaved memory in an open panel is lost)
//     --open            open the installed app
//     --skip-tests      skip the type check and tests
//     --allow-download  let npm fetch the packaging tools if they are not in its cache
// Work folder: ATLAS_BUILD_HOME, default ~/Library/Caches/light-the-earth. It holds a copy of the project
// (builds and tests write into the tree), the packaging tools, and the output; macOS neither syncs nor
// routinely clears it, and the script recreates whatever is missing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const project = path.join(import.meta.dirname, '..');
const home = path.resolve(process.env.ATLAS_BUILD_HOME ?? path.join(os.homedir(), 'Library', 'Caches', 'light-the-earth'));
const src = path.join(home, 'src'), tools = path.join(home, 'desktop-tools'), out = path.join(home, 'out');
const PRODUCT = '点亮地球', BUNDLE_ID = 'site.light-the-earth.atlas';
const target = path.resolve(process.env.ATLAS_INSTALL_PATH ?? `/Applications/${PRODUCT}.app`);
const flag = (name) => process.argv.includes(`--${name}`);
const started = Date.now();

function step(title) { console.log(`\n▸ ${title}`); }
function fail(message) { console.error(`\n✖ ${message}`); process.exit(1); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
}
function link(to, at) {
  try { if (lstatSync(at).isSymbolicLink()) rmSync(at); } catch { /* nothing there yet */ }
  if (!existsSync(at)) symlinkSync(to, at);
}
const appRunning = () => spawnSync('pgrep', ['-f', `${target}/Contents/MacOS/`]).status === 0;

if (process.platform !== 'darwin') fail('This script builds and installs the macOS app; use desktop/build.mjs elsewhere.');
if (!existsSync(path.join(project, 'node_modules'))) fail('Run `npm install` in the project first.');
if (flag('install') && appRunning() && !flag('quit')) fail(`${PRODUCT} is open. Quit it, or rerun with --quit (an unsaved memory in an open panel would be lost).`);

step(`Copying the project to ${src}`);
mkdirSync(home, { recursive: true });
// Excluded paths in the copy are left alone by --delete, so the two dependency links below survive.
run('rsync', ['-a', '--delete', '--exclude', '/node_modules', '--exclude', '/dist', '--exclude', '/dist-desktop', '--exclude', '/outputs',
  '--exclude', '/desktop/node_modules', '--exclude', '.DS_Store', `${project}/`, `${src}/`]);
link(path.join(project, 'node_modules'), path.join(src, 'node_modules'));

step('Checking the packaging tools');
mkdirSync(tools, { recursive: true });
const manifest = readFileSync(path.join(project, 'desktop', 'package.json'));
const stamp = createHash('sha256').update(manifest).digest('hex'), stampFile = path.join(tools, '.installed');
if (!existsSync(path.join(tools, 'node_modules', '@electron', 'packager')) || (existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : '') !== stamp) {
  writeFileSync(path.join(tools, 'package.json'), manifest);
  // Offline first: npm's cache and Electron's own download cache usually hold everything.
  const offline = spawnSync('npm', ['install', '--offline', '--no-audit', '--no-fund'], { cwd: tools, stdio: 'inherit' });
  if (offline.status !== 0) {
    if (!flag('allow-download')) fail('The packaging tools (@electron/packager, Electron) are not in the local caches. Rerun with --allow-download to fetch them.');
    run('npm', ['install', '--no-audit', '--no-fund'], { cwd: tools });
  }
  writeFileSync(stampFile, stamp);
} else console.log('  already installed');
link(path.join(tools, 'node_modules'), path.join(src, 'desktop', 'node_modules'));

if (!flag('skip-tests')) {
  step('Type check and tests');
  run('npm', ['run', '-s', 'typecheck'], { cwd: src });
  run('npm', ['test', '-s'], { cwd: src });
}

step('Building the map data and interface');
run('npm', ['run', '-s', 'build'], { cwd: src });

step('Packaging the app');
run(process.execPath, [path.join(src, 'desktop', 'build.mjs')], { cwd: src, env: { ...process.env, ATLAS_DESKTOP_OUT: out } });
const app = path.join(out, 'release', `${PRODUCT}-darwin-${process.arch}`, `${PRODUCT}.app`);
if (!existsSync(app)) fail(`The packaged app is missing: ${app}`);
run('codesign', ['--verify', '--deep', '--strict', app]);
console.log(`  built ${app}`);

if (flag('install')) {
  step(`Installing to ${target}`);
  if (appRunning()) {
    // Quit through the app itself so it can finish writing; never kill it.
    spawnSync('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], { stdio: 'inherit' });
    for (let i = 0; i < 60 && appRunning(); i++) spawnSync('sleep', ['0.25']);
    if (appRunning()) fail(`${PRODUCT} did not quit; nothing was replaced.`);
  }
  // Copy next to the target first, so a failed copy never leaves the old app half removed.
  const staging = `${target}.new`;
  rmSync(staging, { recursive: true, force: true });
  run('ditto', [app, staging]);
  run('codesign', ['--verify', '--deep', '--strict', staging]);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  run('codesign', ['--verify', '--deep', '--strict', target]);
  console.log(`  installed; records in ~/Library/Application Support/${PRODUCT}/atlas are untouched`);
  if (flag('open')) run('open', [target]);
}
console.log(`\n✔ Done in ${Math.round((Date.now() - started) / 1000)} s`);
