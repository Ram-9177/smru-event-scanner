/**
 * Crash restart (supervisor.ts) with a dummy app process.
 * Run: node --test scripts/*.test.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { superviseApp } from './supervisor.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await wait(20);
  }
}
/** A dummy app: exits with `code` after `ms`, or runs until stopped (code null). */
const all: ChildProcess[] = [];
const dummy = (code: number | null, ms = 30): ChildProcess => {
  const c = spawn(process.execPath, ['-e', code === null ? 'setInterval(() => {}, 1000)' : `setTimeout(() => process.exit(${code}), ${ms})`], {
    stdio: 'ignore',
  });
  all.push(c);
  return c;
};
// Whatever happens in a test, no dummy app is left running.
const sups: { stop(): void }[] = [];
after(() => {
  for (const s of sups) s.stop();
  for (const c of all) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

describe('the app is started again when it stops', () => {
  test('restarts with the backoff and says when it runs again', async () => {
    const lines: string[] = [];
    const plan = [3, 1, null]; // crash, crash, then stays up
    let spawned = 0;
    let gaveUp = '';
    const sup = superviseApp({
      spawnApp: () => dummy(plan[Math.min(spawned++, plan.length - 1)]),
      say: (l) => lines.push(l),
      giveUp: (m) => (gaveUp = m),
      answering: async () => true,
      delaysMs: [20, 50],
    });
    sups.push(sup);
    await until('running again twice', () => lines.filter((l) => l === 'The app is running again.').length === 2);
    assert.deepEqual(lines, [
      'The app stopped (3). Starting it again in 0.02 seconds (crash 1 of 5 in 10 minutes).',
      'The app is running again.',
      'The app stopped (1). Starting it again in 0.05 seconds (crash 2 of 5 in 10 minutes).',
      'The app is running again.',
    ]);
    assert.equal(spawned, 3);
    assert.equal(gaveUp, '');
    const c = sup.child()!;
    sup.stop();
    await new Promise((r) => c.once('exit', r));
    await wait(100);
    assert.equal(spawned, 3); // stopping is not a crash
  });

  test('a signal is named', async () => {
    const lines: string[] = [];
    let n = 0;
    const sup = superviseApp({ spawnApp: () => dummy(null), say: (l) => lines.push(l), giveUp: () => {}, delaysMs: [20] });
    sups.push(sup);
    await wait(100);
    const first = sup.child()!;
    first.kill('SIGKILL');
    await until('restarted', () => sup.child() !== null && sup.child() !== first);
    assert.equal(lines[0], 'The app stopped (SIGKILL). Starting it again in 0.02 seconds (crash 1 of 5 in 10 minutes).');
    n = sup.crashes();
    assert.equal(n, 1);
    const c = sup.child()!;
    sup.stop();
    await new Promise((r) => c.once('exit', r));
  });

  test('5 crashes within the window: gives up once, with the message', async () => {
    const lines: string[] = [];
    let spawned = 0;
    const gave: string[] = [];
    superviseApp({
      spawnApp: () => (spawned++, dummy(1, 10)),
      say: (l) => lines.push(l),
      giveUp: (m) => gave.push(m),
      delaysMs: [10, 20, 30, 40, 50],
    });
    await until('gave up', () => gave.length > 0);
    await wait(150);
    assert.deepEqual(gave, ['the app crashed 5 times in 10 minutes. The last lines are in logs/start.log.']);
    assert.equal(spawned, 5);
    assert.deepEqual(
      lines.map((l) => l.replace(/ in [\d.]+ seconds/, ' in N seconds')),
      [
        'The app stopped (1). Starting it again in N seconds (crash 1 of 5 in 10 minutes).',
        'The app stopped (1). Starting it again in N seconds (crash 2 of 5 in 10 minutes).',
        'The app stopped (1). Starting it again in N seconds (crash 3 of 5 in 10 minutes).',
        'The app stopped (1). Starting it again in N seconds (crash 4 of 5 in 10 minutes).',
        'The app stopped (1).',
      ],
    );
    assert.deepEqual(
      lines.slice(0, 4).map((l) => /in ([\d.]+) seconds/.exec(l)![1]),
      ['0.01', '0.02', '0.03', '0.04'],
    );
  });

  test('crashes spread out over more than the window do not give up', async () => {
    let spawned = 0;
    const gave: string[] = [];
    const sup = superviseApp({
      spawnApp: () => (spawned++ < 7 ? dummy(1, 40) : dummy(null)),
      say: () => {},
      giveUp: (m) => gave.push(m),
      delaysMs: [10],
      windowMs: 120,
    });
    sups.push(sup);
    await until('eighth start', () => spawned >= 8 && sup.child() !== null, 8000);
    assert.deepEqual(gave, []);
    assert.ok(sup.crashes() < 5);
    const c = sup.child()!;
    sup.stop();
    await new Promise((r) => c.once('exit', r));
  });

  test('stop during the wait: no restart', async () => {
    let spawned = 0;
    const sup = superviseApp({ spawnApp: () => (spawned++, dummy(2, 10)), say: () => {}, giveUp: () => {}, delaysMs: [200] });
    await until('first crash', () => sup.crashes() === 1);
    sup.stop();
    await wait(300);
    assert.equal(spawned, 1);
    assert.equal(sup.child(), null);
  });
});
