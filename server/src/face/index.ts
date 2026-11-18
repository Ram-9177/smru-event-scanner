/** One face found in a photo: its box in the working copy, the detector's score and the 128-number vector. */
export interface FoundFace {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  vector: Float32Array;
}

/**
 * The face engine behind one small interface, as the plan asks.
 * The real one is the Python service (YuNet + SFace); tests use a stand-in.
 */
export interface FaceEngine {
  /** Stored with every vector; vectors from two models are never compared. */
  model: string;
  health(): Promise<boolean>;
  /** 256-bit look-alike hash of an upright working copy, as 32 bytes. */
  fingerprint(jpeg: Buffer): Promise<Buffer>;
  /** Every face at least minFacePx wide. */
  faces(jpeg: Buffer, minFacePx: number): Promise<FoundFace[]>;
  /** The largest face of a selfie, or null when no face is seen. */
  selfie(jpeg: Buffer): Promise<{ vector: Float32Array; faces: number } | null>;
  /** A description of the photo's scene, to find the same shot taken twice, and how sharp the photo is. */
  scene(jpeg: Buffer): Promise<{ desc: Buffer; sharpness: number }>;
  /** How far two scene descriptions show the same shot. */
  compare(a: Buffer, b: Buffer): Promise<SceneMatch>;
}

/** inliers: keypoints that agree on one camera movement; cover: the share of the view both photos show; ncc: how alike they look laid on top. */
export interface SceneMatch {
  inliers: number;
  ratio: number;
  cover: number;
  ncc: number;
}

export const vectorToBuffer = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

export function bufferToVector(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/** The face service is not answering at all. Nothing is wrong with the photo: the work waits and is tried again. */
export class FaceDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaceDownError';
  }
}
class FaceServiceError extends Error {}

/** Client for the Python face service. Only the server talks to it, never the browser. */
export function httpFace(baseUrl: string, model: string): FaceEngine {
  async function post(path: string, body: Buffer): Promise<{ status: number; data: any }> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(body) });
    } catch {
      throw new FaceDownError(`The face service is not answering at ${baseUrl}. Start it with: npm run face`);
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 422) throw new FaceServiceError(`The face service answered ${res.status}: ${data.error || ''}`);
    return { status: res.status, data };
  }
  const vec = (b64: string) => bufferToVector(Buffer.from(b64, 'base64'));
  return {
    model,
    async health() {
      try {
        const r = await fetch(`${baseUrl}/health`);
        return r.ok;
      } catch {
        return false;
      }
    },
    async fingerprint(jpeg) {
      const { data } = await post('/fingerprint', jpeg);
      return Buffer.from(data.hash, 'hex');
    },
    async faces(jpeg, minFacePx) {
      const { data } = await post(`/faces?min_face=${minFacePx}`, jpeg);
      return (data.faces as any[]).map((f) => ({ x: f.box[0], y: f.box[1], w: f.box[2], h: f.box[3], score: f.score, vector: vec(f.vec) }));
    },
    async selfie(jpeg) {
      const { status, data } = await post('/selfie', jpeg);
      if (status === 422) return null;
      return { vector: vec(data.vec), faces: data.faces };
    },
    async scene(jpeg) {
      const { data } = await post('/scene', jpeg);
      return { desc: Buffer.from(data.desc, 'base64'), sharpness: Number(data.sharpness) || 0 };
    },
    async compare(a, b) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/compare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: a.toString('base64'), b: b.toString('base64') }) });
      } catch {
        throw new FaceDownError(`The face service is not answering at ${baseUrl}. Start it with: npm run face`);
      }
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new FaceServiceError(`The face service answered ${res.status}: ${data.error || ''}`);
      return { inliers: data.inliers ?? 0, ratio: data.ratio ?? 0, cover: data.cover ?? 0, ncc: data.ncc ?? 0 };
    },
  };
}
