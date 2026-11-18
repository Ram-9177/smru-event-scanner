/**
 * The login service file (service.ts). Nothing is installed: only the text and --dry-run.
 * Run: node --test scripts/*.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { LABEL, plistXml, stableNode } from './service.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('the LaunchAgent runs start.ts --service under caffeinate, kept alive, logging into logs/', () => {
  const xml = plistXml({ root: '/Users/me/Event & Photos', node: '/opt/node/bin/node' });
  assert.equal(LABEL, 'local.event-photos');
  assert.match(xml, /<key>Label<\/key>\s*<string>local\.event-photos<\/string>/);
  const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const i = args.indexOf('/usr/bin/caffeinate');
  assert.deepEqual(args.slice(i, i + 5), [
    '/usr/bin/caffeinate',
    '-is',
    '/opt/node/bin/node',
    '/Users/me/Event &amp; Photos/scripts/start.ts',
    '--service',
  ]);
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/Event &amp; Photos<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/Event &amp; Photos\/logs\/service\.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/Event &amp; Photos\/logs\/service\.log<\/string>/);
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  // A node already in the usual places is not listed twice.
  assert.match(plistXml({ node: '/opt/homebrew/bin/node' }), /<string>\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
});

test('plutil accepts it (Mac only)', { skip: process.platform !== 'darwin' }, () => {
  const r = spawnSync('/usr/bin/plutil', ['-lint', '-'], { input: plistXml(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('install --dry-run prints the file and changes nothing; no command prints the use', () => {
  const dry = spawnSync(process.execPath, [path.join(HERE, 'service.ts'), 'install', '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^Would write .*Library\/LaunchAgents\/local\.event-photos\.plist:/);
  assert.match(dry.stdout, /<string>--service<\/string>/);
  const use = spawnSync(process.execPath, [path.join(HERE, 'service.ts')], { encoding: 'utf8' });
  assert.equal(use.status, 0);
  assert.match(use.stdout, /^Use: npm run service install \| status \| stop \| start \| uninstall/);
  const bad = spawnSync(process.execPath, [path.join(HERE, 'service.ts'), 'nonsense'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('runs Homebrew node through its stable link, not the versioned Cellar folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-node-'));
  const real = path.join(dir, 'Cellar', 'node', '24.7.0', 'bin', 'node');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '');
  const link = path.join(dir, 'bin-node');
  fs.symlinkSync(real, link);
  assert.equal(stableNode(real, [path.join(dir, 'missing'), link]), link);
  assert.equal(stableNode(real, [path.join(dir, 'missing')]), real);
  assert.equal(stableNode('/usr/bin/node', [link]), '/usr/bin/node');
  fs.rmSync(dir, { recursive: true, force: true });
});
