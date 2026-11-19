/**
 * deploy/update.sh, the live server's updater, run for real against throwaway git repositories: nothing happens
 * when the server runs the newest main; a new commit is built, restarted and checked; a failed build or a version
 * that does not answer is put back as it was; files changed on the server are left alone. The build, the restart
 * and the health answer are stand-ins (files), so no app, network or GitHub is needed.
 * Run: node --test scripts/*.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../deploy/update.sh');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

/** GitHub (a bare repository), a developer's clone that pushes, and the live server's clone with version 1 running. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-update-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
  const origin = path.join(root, 'github.git');
  const dev = path.join(root, 'dev');
  const live = path.join(root, 'live');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, dev);
  const push = (files: Record<string, string | null>, message: string) => {
    for (const [name, text] of Object.entries(files)) {
      if (text === null) fs.rmSync(path.join(dev, name), { force: true });
      else fs.writeFileSync(path.join(dev, name), text);
    }
    git(dev, 'add', '-A');
    git(dev, 'commit', '-q', '-m', message);
    git(dev, 'push', '-q', 'origin', 'HEAD:main');
    return git(dev, 'rev-parse', 'HEAD');
  };
  const first = push({ VERSION: '1\n', 'package-lock.json': '{"v":1}\n', 'README.md': 'Event Photos\n' }, 'version 1');
  git(root, 'clone', '-q', '-b', 'main', origin, live);
  // The build running on the server now: version 1.
  for (const d of ['web/dist', 'server/dist']) {
    fs.mkdirSync(path.join(live, d), { recursive: true });
    fs.writeFileSync(path.join(live, d, 'v'), '1\n');
  }
  const files = { restarts: path.join(root, 'restarts'), installs: path.join(root, 'installs'), health: path.join(root, 'health.json') };
  const env = {
    ...process.env,
    UPDATE_APP_DIR: live,
    // A build that leaves a half-written output when it fails, as a real one can.
    UPDATE_BUILD_CMD: 'mkdir -p web/dist server/dist && echo broken > web/dist/v && test ! -f FAIL_BUILD && cp VERSION web/dist/v && cp VERSION server/dist/v',
    UPDATE_INSTALL_CMD: `echo installed >> '${files.installs}'`,
    // The restarted app answers {"ok":false} when the version carries BAD_HEALTH.
    UPDATE_RESTART_CMD: `echo "restart $(cat server/dist/v)" >> '${files.restarts}'; if [ -f BAD_HEALTH ]; then echo '{"ok":false}'; else echo '{"ok":true}'; fi > '${files.health}'`,
    UPDATE_HEALTH_URL: `file://${files.health}`,
    UPDATE_HEALTH_WAIT: '2',
    UPDATE_HEALTH_DELAY: '0',
  };
  const run = (extra: Record<string, string> = {}) => spawnSync('bash', [SCRIPT], { env: { ...env, ...extra }, encoding: 'utf8' });
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return {
    first,
    push,
    run,
    head: () => git(live, 'rev-parse', 'HEAD'),
    built: () => [read(path.join(live, 'web/dist/v')).trim(), read(path.join(live, 'server/dist/v')).trim()],
    restarts: () => read(files.restarts).trim().split('\n').filter(Boolean),
    installs: () => read(files.installs).trim().split('\n').filter(Boolean),
    log: () => read(path.join(live, 'logs/update.log')),
    live,
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('does nothing when the server already runs the newest main', () => {
  const w = world();
  try {
    assert.equal(w.run().status, 0);
    assert.deepEqual(w.restarts(), []);
    assert.equal(w.log(), '');
    assert.deepEqual(w.built(), ['1', '1']);
  } finally {
    w.done();
  }
});

test('a new commit on main: fetched, built, restarted and checked, and the log says so', () => {
  const w = world();
  try {
    const two = w.push({ VERSION: '2\n' }, 'version 2');
    const r = w.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(w.head(), two);
    assert.deepEqual(w.built(), ['2', '2']);
    assert.deepEqual(w.restarts(), ['restart 2']);
    assert.deepEqual(w.installs(), []); // the packages did not change
    assert.match(w.log(), /updating \w+ -> \w+: version 2/);
    assert.match(w.log(), /now running \w+/);
    assert.equal(fs.existsSync(path.join(w.live, '.update/previous')), false);
    assert.equal(w.run().status, 0); // and the next run has nothing to do
    assert.deepEqual(w.restarts(), ['restart 2']);
  } finally {
    w.done();
  }
});

test('packages that changed are installed before the build', () => {
  const w = world();
  try {
    w.push({ VERSION: '2\n', 'package-lock.json': '{"v":2}\n' }, 'new packages');
    assert.equal(w.run().status, 0);
    assert.deepEqual(w.installs(), ['installed']);
    assert.deepEqual(w.built(), ['2', '2']);
  } finally {
    w.done();
  }
});

test('a build that fails: back to the previous commit and build, the app is not stopped, and that commit is not tried again', () => {
  const w = world();
  try {
    w.push({ VERSION: '3\n', FAIL_BUILD: 'x\n' }, 'broken build');
    assert.equal(w.run().status, 1);
    assert.equal(w.head(), w.first);
    assert.deepEqual(w.built(), ['1', '1']); // the half-written build is gone
    assert.deepEqual(w.restarts(), []);
    assert.match(w.log(), /FAILED: the build did not work\. Going back to \w+/);
    assert.match(w.log(), /still running \w+: it was not stopped/);

    assert.equal(w.run().status, 0); // the same broken commit: left alone, noted once
    assert.equal(w.run().status, 0);
    assert.equal(w.log().match(/waiting for a new commit/g)?.length, 1);
    assert.equal(w.head(), w.first);

    const fixed = w.push({ VERSION: '4\n', FAIL_BUILD: null }, 'fixed');
    assert.equal(w.run().status, 0);
    assert.equal(w.head(), fixed);
    assert.deepEqual(w.built(), ['4', '4']);
  } finally {
    w.done();
  }
});

test('a version that does not answer after the restart: back to the previous one, restarted, and it answers', () => {
  const w = world();
  try {
    w.push({ VERSION: '5\n', BAD_HEALTH: 'x\n' }, 'does not answer');
    assert.equal(w.run().status, 1);
    assert.equal(w.head(), w.first);
    assert.deepEqual(w.built(), ['1', '1']);
    assert.deepEqual(w.restarts(), ['restart 5', 'restart 1']);
    assert.match(w.log(), /FAILED: the app did not answer .* within 2 seconds/);
    assert.match(w.log(), /back on \w+, which answers/);
  } finally {
    w.done();
  }
});

test('files kept in git that were changed on the server are left alone, and nothing is updated (noted once)', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.live, 'README.md'), 'edited on the server\n');
    w.push({ VERSION: '6\n' }, 'version 6');
    assert.equal(w.run().status, 1);
    assert.equal(w.run().status, 1);
    assert.equal(w.head(), w.first);
    assert.equal(fs.readFileSync(path.join(w.live, 'README.md'), 'utf8'), 'edited on the server\n');
    assert.deepEqual(w.restarts(), []);
    assert.equal(w.log().match(/files kept in git were changed on this server \(README\.md\)/g)?.length, 1);
  } finally {
    w.done();
  }
});

test('UPDATE_FORCE=1 builds and restarts even when nothing new came (the first run after setup)', () => {
  const w = world();
  try {
    assert.equal(w.run({ UPDATE_FORCE: '1' }).status, 0);
    assert.deepEqual(w.restarts(), ['restart 1']);
    assert.match(w.log(), /building and restarting \w+ \(asked for\)/);
  } finally {
    w.done();
  }
});

test('without a restart command it does nothing and says how to set it up', () => {
  const w = world();
  try {
    w.push({ VERSION: '7\n' }, 'version 7');
    const r = w.run({ UPDATE_RESTART_CMD: '' });
    assert.equal(r.status, 2);
    assert.equal(w.head(), w.first);
    assert.match(w.log(), /UPDATE_RESTART_CMD is not set/);
  } finally {
    w.done();
  }
});
