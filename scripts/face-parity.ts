/**
 * Parity check: the TypeScript face engine (server/src/face/local.ts) against the Python face service.
 *
 *   npx tsx scripts/face-parity.ts --media <folder> [--py http://127.0.0.1:8001] [--models server/models]  (the Python service is kept in _backup/python-face-service)
 *
 * The app keeps no photos on the Mac any more (they live in OneDrive, "_app copies (do not edit)"): point --media at a
 * folder of web copies downloaded from there (or an older server/data/media), laid out as <event>/<media>_w.jpg.
 *
 * Needs the Python service running (it is only read from). For every display copy <event>/<media>_w.jpg it
 * compares the look-alike hash, the faces (count, box overlap, vector cosine), the selfie vector (whole photo
 * and a few face crops) and the sharpness; for every pair of photos inside one event it compares the scene
 * numbers of both engines and whether the burst rule (bursts.ts) decides the same.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { localFace } from '../server/src/face/local.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const PY = arg('py', 'http://127.0.0.1:8001');
const MEDIA = path.resolve(arg('media', path.join(ROOT, 'server/data/media')));
const MODELS = path.resolve(arg('models', path.join(ROOT, 'server/models')));
const BURST = { inliers: 150, cover: 0.9, ncc: 0.7 };
const SELFIE_CROPS = 12;

interface Vec {
  box: number[];
  score: number;
  vector: Float32Array;
}
const vec = (b64: string) => {
  const b = Buffer.from(b64, 'base64');
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
};
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (a: Float32Array) => Math.sqrt(dot(a, a));
function iou(a: number[], b: number[]) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a[2] * a[3] + b[2] * b[3] - i);
}
function bitsApart(a: Uint8Array, b: Uint8Array) {
  let n = 0;
  for (let i = 0; i < a.length; i++) for (let x = a[i] ^ b[i]; x; x &= x - 1) n++;
  return n;
}
async function py(pathname: string, body: Buffer | string, json = false): Promise<{ status: number; data: any }> {
  const r = await fetch(PY + pathname, {
    method: 'POST',
    headers: { 'content-type': json ? 'application/json' : 'application/octet-stream' },
    body: typeof body === 'string' ? body : new Uint8Array(body),
  });
  return { status: r.status, data: await r.json() };
}
const stats = (xs: number[]) => {
  if (!xs.length) return 'n/a';
  const s = [...xs].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return `mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}  p50 ${pick(0.5).toFixed(1)}  p90 ${pick(0.9).toFixed(1)}  max ${s[s.length - 1].toFixed(1)}  (n=${xs.length})`;
};

async function main() {
  const health = await fetch(`${PY}/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`The Python face service is not answering at ${PY}`);
  console.log(`Python service: OpenCV ${health.opencv}, model ${health.model}`);

  const events = fs
    .readdirSync(MEDIA)
    .filter((d) => fs.statSync(path.join(MEDIA, d)).isDirectory())
    .map((d) => ({
      id: d,
      files: fs.readdirSync(path.join(MEDIA, d)).filter((f) => f.endsWith('_w.jpg')).sort().map((f) => path.join(MEDIA, d, f)),
    }))
    .filter((e) => e.files.length);
  const total = events.reduce((n, e) => n + e.files.length, 0);
  console.log(`${total} photos in ${events.length} events\n`);

  const engine = localFace({ modelsDir: MODELS, workers: 2 });
  let t = performance.now();
  if (!(await engine.health())) throw new Error('The TypeScript face engine did not start');
  console.log(`TS engine ready in ${(performance.now() - t).toFixed(0)} ms`);

  const time: Record<string, number[]> = { fingerprint: [], faces: [], selfie: [], scene: [], compare: [], 'py faces': [], 'py scene': [], 'py compare': [] };
  const fpBits: number[] = [];
  let pyFaces = 0;
  let tsFaces = 0;
  const countDiff: string[] = [];
  const ious: number[] = [];
  const coss: number[] = [];
  const scoreDiffs: number[] = [];
  const boxDiffs: number[] = [];
  const unitErr: number[] = [];
  const lowFaces: string[] = [];
  const sharpDiffs: number[] = [];
  const selfieCos: number[] = [];
  const selfieIssues: string[] = [];
  const crops: { file: string; box: number[] }[] = [];
  const scenes = new Map<string, { py: Buffer; ts: Buffer }>();

  for (const ev of events) {
    for (const file of ev.files) {
      const name = `${ev.id.slice(0, 8)}/${path.basename(file).slice(0, 8)}`;
      const jpeg = fs.readFileSync(file);

      t = performance.now();
      const fp = await engine.fingerprint(jpeg);
      time.fingerprint.push(performance.now() - t);
      const pfp = Buffer.from((await py('/fingerprint', jpeg)).data.hash, 'hex');
      fpBits.push(bitsApart(fp, pfp));

      t = performance.now();
      const pf = (await py('/faces?min_face=24', jpeg)).data;
      time['py faces'].push(performance.now() - t);
      t = performance.now();
      const tf = await engine.faces(jpeg, 24);
      time.faces.push(performance.now() - t);
      const pyList: Vec[] = pf.faces.map((f: any) => ({ box: f.box, score: f.score, vector: vec(f.vec) }));
      const tsList: Vec[] = tf.map((f) => ({ box: [f.x, f.y, f.w, f.h], score: f.score, vector: f.vector }));
      pyFaces += pyList.length;
      tsFaces += tsList.length;
      if (pyList.length !== tsList.length) countDiff.push(`${name}: python ${pyList.length}, ts ${tsList.length}`);
      for (const f of tsList) unitErr.push(Math.abs(norm(f.vector) - 1));
      const used = new Set<number>();
      for (const p of pyList) {
        let best = -1;
        let bestIou = 0;
        tsList.forEach((q, i) => {
          const v = iou(p.box, q.box);
          if (!used.has(i) && v > bestIou) [best, bestIou] = [i, v];
        });
        if (best < 0) {
          lowFaces.push(`${name}: python face ${p.box} (score ${p.score}) has no TS face`);
          continue;
        }
        used.add(best);
        const q = tsList[best];
        const c = dot(p.vector, q.vector);
        ious.push(bestIou);
        coss.push(c);
        scoreDiffs.push(Math.abs(p.score - q.score));
        boxDiffs.push(Math.max(...p.box.map((v, k) => Math.abs(v - q.box[k]))));
        if (c < 0.99 || bestIou < 0.9) lowFaces.push(`${name}: box py ${p.box} ts ${q.box} iou ${bestIou.toFixed(3)} cos ${c.toFixed(4)}`);
        if (crops.length < SELFIE_CROPS && p.box[2] >= 40) crops.push({ file, box: p.box });
      }
      tsList.forEach((q, i) => {
        if (!used.has(i)) lowFaces.push(`${name}: TS face ${q.box} (score ${q.score}) has no python face`);
      });

      t = performance.now();
      const ts = await engine.selfie(jpeg);
      time.selfie.push(performance.now() - t);
      const ps = await py('/selfie', jpeg);
      if ((ps.status === 422) !== (ts === null)) selfieIssues.push(`${name}: python ${ps.status === 422 ? 'no face' : 'face'}, ts ${ts ? 'face' : 'no face'}`);
      else if (ts) {
        const c = dot(vec(ps.data.vec), ts.vector);
        selfieCos.push(c);
        if (c < 0.99 || ps.data.faces !== ts.faces) selfieIssues.push(`${name}: whole photo cos ${c.toFixed(4)} faces py ${ps.data.faces} ts ${ts.faces}`);
      }

      t = performance.now();
      const tsc = await engine.scene(jpeg);
      time.scene.push(performance.now() - t);
      t = performance.now();
      const psc = (await py('/scene', jpeg)).data;
      time['py scene'].push(performance.now() - t);
      sharpDiffs.push(Math.abs(Number(psc.sharpness) - tsc.sharpness));
      scenes.set(file, { py: Buffer.from(psc.desc, 'base64'), ts: tsc.desc });
      process.stdout.write('.');
    }
  }
  console.log('\n');

  // selfies cut out of photos: a face with room around it, like a phone selfie
  for (const { file, box } of crops) {
    const meta = await sharp(file).metadata();
    const [x, y, w, h] = box;
    const left = Math.max(0, Math.round(x - w));
    const top = Math.max(0, Math.round(y - h));
    const width = Math.min(meta.width! - left, Math.round(w * 3));
    const height = Math.min(meta.height! - top, Math.round(h * 3));
    const crop = await sharp(file).extract({ left, top, width, height }).jpeg({ quality: 90 }).toBuffer();
    const ts = await engine.selfie(crop);
    const ps = await py('/selfie', crop);
    const name = `crop ${path.basename(file).slice(0, 8)} ${box}`;
    if ((ps.status === 422) !== (ts === null)) selfieIssues.push(`${name}: python ${ps.status === 422 ? 'no face' : 'face'}, ts ${ts ? 'face' : 'no face'}`);
    else if (ts) {
      const c = dot(vec(ps.data.vec), ts.vector);
      selfieCos.push(c);
      if (c < 0.99) selfieIssues.push(`${name}: cos ${c.toFixed(4)}`);
    }
  }

  // every pair of photos inside one event
  let pairs = 0;
  let same = 0;
  let agree = 0;
  let pyBursts = 0;
  let tsBursts = 0;
  const dInl: number[] = [];
  const dCover: number[] = [];
  const dNcc: number[] = [];
  const dRatio: number[] = [];
  const disagree: string[] = [];
  const near: string[] = [];
  const decide = (m: { inliers: number; cover: number; ncc: number }) => m.inliers >= BURST.inliers && m.cover >= BURST.cover && m.ncc >= BURST.ncc;
  for (const ev of events) {
    for (let i = 0; i < ev.files.length; i++) {
      for (let j = i + 1; j < ev.files.length; j++) {
        const A = scenes.get(ev.files[i])!;
        const B = scenes.get(ev.files[j])!;
        t = performance.now();
        const p = (await py('/compare', JSON.stringify({ a: A.py.toString('base64'), b: B.py.toString('base64') }), true)).data;
        time['py compare'].push(performance.now() - t);
        t = performance.now();
        const q = await engine.compare(A.ts, B.ts);
        time.compare.push(performance.now() - t);
        pairs++;
        if (p.inliers === q.inliers && p.cover === q.cover && p.ncc === q.ncc && p.ratio === q.ratio) same++;
        dInl.push(Math.abs(p.inliers - q.inliers));
        dCover.push(Math.abs(p.cover - q.cover));
        dNcc.push(Math.abs(p.ncc - q.ncc));
        dRatio.push(Math.abs(p.ratio - q.ratio));
        const dp = decide(p);
        const dq = decide(q);
        if (dp) pyBursts++;
        if (dq) tsBursts++;
        const label = `${ev.id.slice(0, 8)} ${path.basename(ev.files[i]).slice(0, 8)} x ${path.basename(ev.files[j]).slice(0, 8)}: py ${JSON.stringify(p)} ts ${JSON.stringify(q)}`;
        if (dp === dq) agree++;
        else disagree.push(label);
        if (p.inliers !== q.inliers || Math.abs(p.cover - q.cover) > 0.001 || Math.abs(p.ncc - q.ncc) > 0.001) near.push(label);
      }
    }
  }

  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : 0);
  console.log('=== Photos ===');
  console.log(`fingerprint: identical ${fpBits.filter((b) => b === 0).length}/${fpBits.length}, max bits apart ${max(fpBits)}`);
  console.log(`faces: python ${pyFaces}, ts ${tsFaces}; photos with a different count: ${countDiff.length}/${total}`);
  for (const l of countDiff) console.log(`  ${l}`);
  console.log(`matched faces ${coss.length}: cosine min ${min(coss).toFixed(5)}, mean ${(coss.reduce((a, b) => a + b, 0) / Math.max(1, coss.length)).toFixed(6)}; box IoU min ${min(ious).toFixed(4)}; box max px diff ${max(boxDiffs)}; score max diff ${max(scoreDiffs).toFixed(4)}`);
  console.log(`vector length: max |norm - 1| ${max(unitErr).toExponential(2)}`);
  for (const l of lowFaces) console.log(`  ${l}`);
  console.log(`selfie: ${selfieCos.length} compared (whole photos + ${crops.length} crops), cosine min ${min(selfieCos).toFixed(5)}; issues ${selfieIssues.length}`);
  for (const l of selfieIssues) console.log(`  ${l}`);
  console.log(`sharpness: max abs diff ${max(sharpDiffs).toFixed(2)} (identical ${sharpDiffs.filter((d) => d === 0).length}/${sharpDiffs.length})`);
  console.log('\n=== Pairs (same event) ===');
  console.log(`${pairs} pairs: all four numbers identical in ${same}; max diff inliers ${max(dInl)}, ratio ${max(dRatio).toFixed(4)}, cover ${max(dCover).toFixed(4)}, ncc ${max(dNcc).toFixed(4)}`);
  console.log(`burst decision agrees on ${agree}/${pairs} (python ${pyBursts} bursts, ts ${tsBursts})`);
  for (const l of disagree) console.log(`  DISAGREE ${l}`);
  if (near.length) {
    console.log(`pairs with any number different (${near.length}):`);
    for (const l of near.slice(0, 30)) console.log(`  ${l}`);
  }
  console.log('\n=== Timings (ms per call, TS engine through its worker pool, one call at a time) ===');
  for (const [k, v] of Object.entries(time)) console.log(`${k.padEnd(12)} ${stats(v)}`);
  await engine.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
