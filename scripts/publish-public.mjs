#!/usr/bin/env node
// Brings the public GitHub copy up to date with a commit of this repository.
//   node scripts/publish-public.mjs [--push] [--ref=main] [--message="..."]
// Without --push it only prepares and shows what would change. The public copy has its own history:
// one commit per sync, written under the public identity, never this repository's commits or authors.
//
// Steps: export the tracked files of --ref (default main; the working tree must be clean), leave out
// the development records, turn links into them into plain text, refuse to continue if any file
// name, file or the commit message contains something private, then replace the public mirror's
// files with the export and commit.
//
// Settings live in this repository's git config, which is never exported:
//   publish.remote  the public repository URL (needed only to clone the mirror again)
//   publish.mirror  the mirror checkout (default ~/Library/Caches/light-the-earth/public-repo)
//   publish.name / publish.email   the public commit identity (default: the mirror's own)
//   publish.forbid  text that must never be published; repeatable (git config --add publish.forbid ...)
// This repository's user.name and user.email (and the global user.email) are always forbidden too, as is any /Users/ path.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const project = path.join(import.meta.dirname, '..');
// Development records: review notes and plans that mention private details.
const EXCLUDED = ['docs/reviews', 'docs/superpowers'];
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const push = process.argv.includes('--push');
const ref = option('ref') ?? 'main';

function fail(message) { console.error(`\n✖ ${message}`); process.exit(1); }
function git(args, { cwd = project, input, allowFail = false } = {}) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.status !== 0 && !allowFail) fail(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.status === 0 ? result.stdout.trim() : '';
}
const config = (key) => git(['config', '--get', key], { allowFail: true });
const configAll = (key) => git(['config', '--get-all', key], { allowFail: true }).split('\n').filter(Boolean);

// 1. What may never appear in public.
const globalEmail = git(['config', '--global', '--get', 'user.email'], { allowFail: true });
const forbidden = [...new Set([...configAll('publish.forbid'), config('user.name'), config('user.email'), globalEmail].map((s) => s.trim()).filter((s) => s.length >= 3))];
if (!forbidden.length) fail('No private text is configured; set user.name/user.email or publish.forbid first.');

// 2. Export the tracked files of the chosen commit.
if (git(['status', '--porcelain'])) fail('The working tree has uncommitted changes; commit them first so the public copy matches a commit.');
const source = git(['rev-parse', '--short', ref]);
const stage = mkdtempSync(path.join(os.tmpdir(), 'light-the-earth-public-'));
process.on('exit', () => rmSync(stage, { recursive: true, force: true }));
const archive = spawnSync('git', ['archive', ref], { cwd: project, maxBuffer: 1 << 30 });
if (archive.status !== 0) fail(`git archive ${ref} failed`);
const untar = spawnSync('tar', ['-x', '-C', stage], { input: archive.stdout });
if (untar.status !== 0) fail('Could not unpack the export');
for (const excluded of EXCLUDED) rmSync(path.join(stage, excluded), { recursive: true, force: true });

// 3. Links into the left-out records keep their words, without the link.
const files = [];
(function walk(dir) { for (const name of readdirSync(dir)) { const full = path.join(dir, name); statSync(full).isDirectory() ? walk(full) : files.push(full); } })(stage);
const linkPattern = new RegExp(String.raw`\[([^\]]+)\]\((?:\.\./)?(?:docs/)?(?:${EXCLUDED.map((p) => p.replace(/^docs\//, '')).join('|')})/[^)]*\)`, 'g');
for (const file of files.filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(file, 'utf8'), unlinked = text.replace(linkPattern, '$1');
  if (unlinked !== text) writeFileSync(file, unlinked);
}

// 4. The message lists this repository's commits since the last sync, by subject only.
const mirror = path.resolve(config('publish.mirror') || path.join(os.homedir(), 'Library', 'Caches', 'light-the-earth', 'public-repo'));
if (!existsSync(path.join(mirror, '.git'))) {
  const remote = config('publish.remote');
  if (!remote) fail(`No public mirror at ${mirror} and no publish.remote to clone it from.`);
  const clone = spawnSync('git', ['clone', '-q', remote, mirror], { stdio: 'inherit' });
  if (clone.status !== 0) fail('Could not clone the public repository');
}
git(['pull', '-q', '--ff-only'], { cwd: mirror });
const last = git(['log', '-1', '--format=%(trailers:key=Source-Commit,valueonly)'], { cwd: mirror }).trim();
const range = last && git(['cat-file', '-t', last], { allowFail: true }) === 'commit' ? `${last}..${ref}` : `-1 ${ref}`;
const subjects = git(['log', '--no-merges', '--format=- %s', ...range.split(' ')]).split('\n').filter(Boolean);
const message = option('message') ?? `Sync with the private repository\n\n${subjects.join('\n') || '- Updates'}\n\nSource-Commit: ${source}\n`;

// 5. Nothing private in names, contents or the message.
const leaks = [];
const lower = forbidden.map((s) => s.toLowerCase());
const check = (where, text) => { const t = text.toLowerCase(); lower.forEach((s, i) => { if (t.includes(s)) leaks.push(`${where} contains forbidden text #${i + 1}`); }); if (/\/Users\/[A-Za-z]/.test(text)) leaks.push(`${where} contains a /Users/ path`); };
for (const file of files) {
  if (!existsSync(file)) continue;
  const relative = path.relative(stage, file);
  check(`file name ${relative}`, relative);
  const bytes = readFileSync(file);
  if (!bytes.subarray(0, 8000).includes(0)) check(relative, bytes.toString('utf8'));
}
check('commit message', message);
if (leaks.length) fail(`Private text found; nothing was published:\n  ${leaks.slice(0, 20).join('\n  ')}`);
console.log(`✔ ${files.length} files from ${ref} (${source}) checked against ${forbidden.length} private entries`);

// 6. Replace the mirror's files with the export and show the change.
const sync = spawnSync('rsync', ['-a', '--delete', '--exclude', '/.git', `${stage}/`, `${mirror}/`], { stdio: 'inherit' });
if (sync.status !== 0) fail('Could not update the public mirror');
git(['add', '-A'], { cwd: mirror });
const summary = git(['diff', '--cached', '--stat'], { cwd: mirror });
if (!summary) { console.log('The public copy already matches; nothing to publish.'); process.exit(0); }
console.log(`\nChanges for the public copy:\n${summary.split('\n').slice(-12).join('\n')}\n\nCommit message:\n${message}`);
if (!push) {
  git(['reset', '-q', '--hard', 'HEAD'], { cwd: mirror });
  git(['clean', '-qfd'], { cwd: mirror });
  console.log('Dry run: the mirror is back as it was. Rerun with --push to commit and publish.');
  process.exit(0);
}
const name = config('publish.name'), email = config('publish.email');
const identity = name && email ? ['-c', `user.name=${name}`, '-c', `user.email=${email}`] : [];
if (!identity.length && !git(['config', '--get', 'user.email'], { cwd: mirror, allowFail: true })) fail('Set publish.name and publish.email, or a user identity in the mirror.');
git([...identity, 'commit', '-q', '-F', '-'], { cwd: mirror, input: message });
const pushed = spawnSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: mirror, stdio: 'inherit' });
if (pushed.status !== 0) fail('The commit is ready in the mirror but the push failed; run git push there once the network is back.');
console.log(`\n✔ Published ${git(['rev-parse', '--short', 'HEAD'], { cwd: mirror })} to ${git(['remote', 'get-url', 'origin'], { cwd: mirror })}`);
