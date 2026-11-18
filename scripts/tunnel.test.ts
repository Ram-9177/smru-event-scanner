/**
 * The public-link logic (tunnel.ts) against a fake ngrok program and a fake ngrok local API. Never the real ngrok.
 * Run: node --test scripts/*.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { existingTunnel, findNgrok, ngrokDomainFrom, ngrokHostOf, portOfAddr, probe, startTunnel, type Tunnel } from './tunnel.ts';

const DOMAIN = 'fake-tunnel.ngrok-free.dev';
const PORT = 3377;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-fake-ngrok-'));
const fakeNgrok = path.join(dir, 'ngrok');
const argsFile = path.join(dir, 'args');
const runningFile = path.join(dir, 'running');
const failFile = path.join(dir, 'fail');

// The fake ngrok: notes its arguments; with "fail" there it stops at once, else it "serves" until stopped.
fs.writeFileSync(
  fakeNgrok,
  `#!/bin/sh
echo "$@" >> "${argsFile}"
if [ -f "${failFile}" ]; then echo 'lvl=eror msg="fake ngrok failed"'; exit 1; fi
touch "${runningFile}"
trap 'rm -f "${runningFile}"; exit 0' TERM INT
echo 'lvl=warn msg="fake tunnel up"'
while :; do sleep 1 & wait $!; done
`,
  { mode: 0o755 },
);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await wait(20);
  }
}
const starts = () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean) : []);

// The fake local API (127.0.0.1:4040 stand-in) and the fake public address.
let apiTunnels: unknown[] | null = [];
let publicMode: 'auto' | 'ok' | 'offline' | '502' | 'hang' = 'auto';
let seenHeader = '';
function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}
let api: { server: http.Server; url: string };
let pub: { server: http.Server; url: string };
let closedApi: string;

before(async () => {
  api = await listen((req, res) => {
    if (apiTunnels === null) return void res.writeHead(500).end();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tunnels: apiTunnels }));
  });
  pub = await listen((req, res) => {
    seenHeader = String(req.headers['ngrok-skip-browser-warning'] ?? '');
    const mode = publicMode === 'auto' ? (fs.existsSync(runningFile) ? 'ok' : 'offline') : publicMode;
    if (mode === 'hang') return; // never answers
    if (mode === 'ok') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"events":[]}');
    if (mode === '502') return void res.writeHead(502).end('ERR_NGROK_8012');
    res.writeHead(404, { 'ngrok-error-code': 'ERR_NGROK_3200' }).end(`The endpoint ${DOMAIN} is offline. ERR_NGROK_3200`);
  });
  const tmp = await listen(() => {});
  closedApi = `${tmp.url}/api/tunnels`;
  await new Promise((r) => tmp.server.close(r));
});
after(() => {
  api.server.closeAllConnections();
  pub.server.closeAllConnections();
  api.server.close();
  pub.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let lines: string[] = [];
let live: Tunnel | null = null;
beforeEach(() => {
  lines = [];
  apiTunnels = [];
  publicMode = 'auto';
  for (const f of [argsFile, runningFile, failFile]) fs.rmSync(f, { force: true });
});
function tunnel(extra: Partial<Parameters<typeof startTunnel>[0]> = {}): Tunnel {
  live = startTunnel({
    domain: DOMAIN,
    port: PORT,
    ngrok: fakeNgrok,
    say: (l) => lines.push(l),
    api: `${api.url}/api/tunnels`,
    base: pub.url,
    restartDelaysMs: [20, 40, 80],
    firstCheckMs: 3_600_000,
    reuseTimeoutMs: 1000,
    checkTimeoutMs: 1000,
    ...extra,
  });
  return live;
}
async function stopLive(): Promise<void> {
  const c = live?.child();
  live?.stop();
  live = null;
  if (c && c.exitCode === null && c.signalCode === null) await new Promise((r) => c.once('exit', r));
}

describe('small helpers', () => {
  test('domain and addresses', () => {
    assert.equal(ngrokDomainFrom(' https://Galleried-Warless.ngrok-free.dev/ '), 'galleried-warless.ngrok-free.dev');
    assert.equal(ngrokDomainFrom(undefined), '');
    assert.equal(ngrokHostOf('https://galleried-warless-petronila.ngrok-free.dev'), 'galleried-warless-petronila.ngrok-free.dev');
    assert.equal(ngrokHostOf('https://x.ngrok.app/'), 'x.ngrok.app');
    assert.equal(ngrokHostOf('http://localhost:3000'), '');
    assert.equal(ngrokHostOf('https://photos.college.edu'), '');
    assert.equal(ngrokHostOf('not a url'), '');
    assert.equal(portOfAddr('http://localhost:3000'), 3000);
    assert.equal(portOfAddr('localhost:3001'), 3001);
    assert.equal(portOfAddr('3002'), 3002);
    assert.equal(portOfAddr(undefined), null);
  });

  test('findNgrok: NGROK_PATH first, then PATH', () => {
    assert.equal(findNgrok(fakeNgrok), fakeNgrok);
    const was = process.env.PATH;
    process.env.PATH = `${dir}:${was}`;
    try {
      assert.equal(findNgrok(''), fakeNgrok);
      assert.equal(findNgrok('/nowhere/ngrok'), fakeNgrok);
    } finally {
      process.env.PATH = was;
    }
  });

  test('existingTunnel reads the local API', async () => {
    apiTunnels = [
      { public_url: 'https://other.ngrok-free.dev', config: { addr: 'http://localhost:9999' } },
      { public_url: `https://${DOMAIN}/`, config: { addr: `http://localhost:${PORT}` } },
    ];
    assert.deepEqual(await existingTunnel(DOMAIN, `${api.url}/api/tunnels`), { addr: `http://localhost:${PORT}`, port: PORT });
    apiTunnels = [{ public_url: 'https://other.ngrok-free.dev', config: { addr: 'http://localhost:9999' } }];
    assert.equal(await existingTunnel(DOMAIN, `${api.url}/api/tunnels`), null);
    apiTunnels = null;
    assert.equal(await existingTunnel(DOMAIN, `${api.url}/api/tunnels`), null);
    assert.equal(await existingTunnel(DOMAIN, closedApi), null);
  });

  test('probe tells offline, errors and timeouts apart', async () => {
    publicMode = 'ok';
    const ok = await probe(pub.url, 1000);
    assert.equal(ok.ok, true);
    assert.equal(seenHeader, '1');
    publicMode = 'offline';
    const off = await probe(pub.url, 1000);
    assert.deepEqual([off.status, off.offline, off.ok], [404, true, false]);
    publicMode = '502';
    const bad = await probe(pub.url, 1000);
    assert.deepEqual([bad.status, bad.offline, bad.reason], [502, false, 'HTTP 502']);
    publicMode = 'hang';
    const slow = await probe(pub.url, 300);
    assert.equal(slow.status, 0);
    assert.match(slow.reason, /no answer in 0 seconds/);
    const none = await probe(closedApi.replace('/api/tunnels', ''), 500);
    assert.equal(none.status, 0);
    assert.equal(none.reason, 'ECONNREFUSED');
    publicMode = 'auto';
  });
});

describe('starting: reuse, never a second tunnel', () => {
  test('reuses the tunnel the local API lists for this port', async () => {
    apiTunnels = [{ public_url: `https://${DOMAIN}`, config: { addr: `http://localhost:${PORT}` } }];
    const t = tunnel();
    assert.equal(await t.ready, 'reused');
    assert.deepEqual(lines, [`Public link: reusing the ngrok tunnel that is already running (https://${DOMAIN}).`]);
    assert.equal(t.child(), null);
    assert.deepEqual(starts(), []);
    await stopLive();
  });

  test('a tunnel for another port: says so and starts none', async () => {
    apiTunnels = [{ public_url: `https://${DOMAIN}`, config: { addr: 'http://localhost:3999' } }];
    const t = tunnel();
    assert.equal(await t.ready, 'other-port');
    assert.deepEqual(lines, [
      `Public link: the ngrok tunnel already running points at http://localhost:3999, not port ${PORT}. Stop that ngrok and start again.`,
    ]);
    assert.deepEqual(starts(), []);
    await stopLive();
  });

  test('no local API, but the public address answers: reused (a tunnel runs elsewhere)', async () => {
    publicMode = '502';
    const t = tunnel({ api: closedApi });
    assert.equal(await t.ready, 'reused');
    assert.deepEqual(starts(), []);
    await stopLive();
  });

  test('nothing serves the domain: starts ngrok with the fixed URL, and stops only its own', async () => {
    const t = tunnel({ api: closedApi });
    assert.equal(await t.ready, 'started');
    assert.equal(lines[0], `Public link: starting ngrok for https://${DOMAIN} ...`);
    await until('fake ngrok running', () => fs.existsSync(runningFile));
    assert.deepEqual(starts(), [`http --url=https://${DOMAIN} ${PORT} --log=stdout --log-level=warn`]);
    await until('ngrok output shown', () => lines.some((l) => l.startsWith('[ngrok] ') && l.includes('fake tunnel up')));
    assert.ok(t.child());
    await stopLive();
    await until('fake ngrok stopped', () => !fs.existsSync(runningFile));
  });
});

describe('keeping it up', () => {
  test('ngrok stopping is started again with growing delays', async () => {
    fs.writeFileSync(failFile, '');
    const t = tunnel({ api: closedApi, stableMs: 10_000 });
    await t.ready;
    await until('three failed starts', () => starts().length >= 4);
    const restarts = lines.filter((l) => l.startsWith('Public link: ngrok stopped'));
    assert.deepEqual(restarts.slice(0, 3), [
      'Public link: ngrok stopped (1). Starting it again in 0.02 seconds.',
      'Public link: ngrok stopped (1). Starting it again in 0.04 seconds.',
      'Public link: ngrok stopped (1). Starting it again in 0.08 seconds.',
    ]);
    fs.rmSync(failFile);
    await until('running after the failures', () => fs.existsSync(runningFile));
    assert.ok(lines.some((l) => l.includes('[ngrok] lvl=eror msg="fake ngrok failed"')));
    // It stops while up (not long enough to count as stable): the next delay keeps growing.
    const before = starts().length;
    t.child()!.kill('SIGTERM');
    await until('started again', () => starts().length > before && fs.existsSync(runningFile));
    assert.match(lines.filter((l) => l.startsWith('Public link: ngrok stopped')).at(-1)!, /\(0\)\. Starting it again in 0\.08 seconds\./);
    await stopLive();
  });

  test('after staying up long enough the delays start again from the first', async () => {
    fs.writeFileSync(failFile, '');
    const t = tunnel({ api: closedApi, stableMs: 300 });
    await t.ready;
    await until('two failed starts', () => starts().length >= 3);
    fs.rmSync(failFile);
    await until('running', () => fs.existsSync(runningFile));
    await wait(400);
    t.child()!.kill('SIGTERM');
    await until('restarted', () => lines.filter((l) => l.startsWith('Public link: ngrok stopped (0)')).length === 1);
    assert.match(lines.filter((l) => l.startsWith('Public link: ngrok stopped')).at(-1)!, /Starting it again in 0\.02 seconds\./);
    await until('running again', () => fs.existsSync(runningFile));
    await stopLive();
  });

  test('a restart reuses a tunnel someone started meanwhile instead of a second one', async () => {
    fs.writeFileSync(failFile, '');
    const t = tunnel({ restartDelaysMs: [150] });
    await t.ready;
    await until('first start failed', () => lines.some((l) => l.startsWith('Public link: ngrok stopped')));
    apiTunnels = [{ public_url: `https://${DOMAIN}`, config: { addr: `localhost:${PORT}` } }];
    await until('reused', () => lines.some((l) => l.startsWith('Public link: reusing')));
    await wait(200);
    assert.equal(starts().length, 1);
    await stopLive();
  });

  test('the check says DOWN once (again after an hour), starts ngrok, and says when it works again', async () => {
    apiTunnels = [{ public_url: `https://${DOMAIN}`, config: { addr: `http://localhost:${PORT}` } }];
    const t = tunnel();
    assert.equal(await t.ready, 'reused');
    // The reused tunnel goes away: the public address says offline, the local API lists nothing.
    apiTunnels = [];
    publicMode = 'offline';
    await t.check();
    assert.equal(lines.at(-2), `Public link is DOWN: https://${DOMAIN} did not answer (ngrok says nothing is serving it). Students cannot open it.`);
    assert.equal(lines.at(-1), `Public link: starting ngrok for https://${DOMAIN} ...`);
    await until('ours running', () => fs.existsSync(runningFile));
    const said = lines.length;
    await t.check(); // still down (fixed mode): no second DOWN line within the hour, no second ngrok
    assert.equal(lines.slice(said).filter((l) => l.includes('DOWN')).length, 0);
    assert.equal(starts().length, 1);
    publicMode = 'auto';
    await t.check();
    assert.equal(lines.at(-1), `Public link works again: https://${DOMAIN}`);
    await stopLive();
  });

  test('down but the app is what fails (502): no ngrok started; repeats after downRepeat', async () => {
    const t = tunnel({ api: closedApi, downRepeatMs: 50 });
    await t.ready;
    await until('ours running', () => fs.existsSync(runningFile));
    publicMode = '502';
    await t.check();
    await t.check();
    assert.equal(lines.filter((l) => l.includes('DOWN')).length, 1);
    await wait(60);
    await t.check();
    assert.equal(lines.filter((l) => l.includes('did not answer (HTTP 502)')).length, 2);
    assert.equal(starts().length, 1);
    await stopLive();
  });

  test('the timer checks by itself', async () => {
    apiTunnels = [{ public_url: `https://${DOMAIN}`, config: { addr: `http://localhost:${PORT}` } }];
    publicMode = 'hang';
    const t = tunnel({ firstCheckMs: 10, checkEveryMs: 10_000, checkTimeoutMs: 100 });
    await t.ready;
    await until('timer check', () => lines.some((l) => l.includes('DOWN') && l.includes('no answer in 0 seconds')));
    assert.equal(starts().length, 0); // the local API lists our tunnel: never a second one
    await stopLive();
  });
});
