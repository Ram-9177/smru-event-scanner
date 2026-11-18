// A stand-in for src/face/face-worker.ts that speaks the same messages, for testing the worker pool (local.ts)
// without models. What it does with a job is written in the job's bytes:
//   "sleep:N"  answers after N ms        "hang"  never answers        "die"  the worker ends at once
//   "bad"      fails with BadImageError  "poison"  fails as OpenCV does when its memory is damaged
// Any other bytes are answered at once. A selfie's answer carries the worker's thread id in `faces`.
// The worker does not start while a file named "fail-start" is in the models folder.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, threadId, workerData } from 'node:worker_threads';

const init = workerData.faceWorker;
if (fs.existsSync(path.join(init.modelsDir, 'fail-start'))) {
  parentPort.postMessage({ ready: false, message: 'not enough memory to start' });
} else {
  let broken = '';
  parentPort.on('message', async (req) => {
    const what = Buffer.from(req.jpeg ?? req.a ?? new Uint8Array()).toString();
    if (broken) return parentPort.postMessage({ id: req.id, ok: false, poisoned: true, name: 'Error', message: broken });
    if (what === 'hang') return;
    if (what === 'die') process.exit(1);
    if (what === 'bad') return parentPort.postMessage({ id: req.id, ok: false, name: 'BadImageError', message: 'The photo could not be read: unsupported image format' });
    if (what === 'poison') {
      broken = 'still broken';
      return parentPort.postMessage({ id: req.id, ok: false, poisoned: true, name: 'Error', message: 'OpenCV: inv_scale_x > 0' });
    }
    if (what.startsWith('sleep:')) await new Promise((r) => setTimeout(r, Number(what.slice(6))));
    const result = req.op === 'fingerprint' ? new Uint8Array(32) : { vector: new Float32Array(128), faces: threadId };
    parentPort.postMessage({ id: req.id, ok: true, result });
  });
  parentPort.postMessage({ ready: true });
}
