import type { Ctx } from '../context.js';
import { toBuffer, type Queryable } from '../db/index.js';
import { bufferToVector } from '../face/index.js';
import { bitsApart } from '../lib/hashes.js';
import { mediaChanged } from './after.js';
import { markCopy } from './duplicates.js';
import { legacySceneKey } from './files.js';
import { prepare, sceneCopy } from './prepare.js';
import { emptyCopyTrashSoon, forget, isDriveKey, putCopy, readCopy, removeLegacy, withOriginal } from './copies.js';
import { purgeKeys } from './copyurls.js';
import { DriveNotFoundError } from '../drive/types.js';

/**
 * The same shot taken twice: burst shots, "one more, please", the same group photo three times.
 * The plan's first duplicate rule only caught the very same file or a near-identical copy (a 256-bit look-alike
 * hash), and a hand moving between two frames is enough to defeat that. This rule compares what the photos show:
 *
 *   1. candidates: photos of the event that look roughly alike (look-alike hash within LOOSE_BITS), or were
 *      taken within SAME_MOMENT_MS of each other; at most MAX_CANDIDATES, the closest first
 *   2. the face service matches keypoints between the two and checks they agree on one camera movement, that
 *      the two photos cover the same view (a zoomed-in crop is a different photo), and that laid on top of
 *      each other they look alike
 *   3. the people must be the same: the faces in one photo are the faces in the other (face recognition).
 *      Two different groups in front of the same stage are not the same shot.
 *
 * The better photo of the two stays (yours before a student's, then the larger, then the sharper); the other
 * becomes a copy of it: kept with a thumbnail under "Duplicates", where "Show anyway" brings it back for good.
 * Cut-offs measured on real event photos (the Python original is in _backup/python-face-service): every burst pair found, no false pair.
 */
export const BURST = {
  inliers: 150,
  cover: 0.9,
  ncc: 0.7,
  LOOSE_BITS: 110,
  SAME_MOMENT_MS: 30_000,
  MAX_CANDIDATES: 30,
  /** Two faces are the same person at this similarity (SFace cosine); measured: same person 0.73-0.95, others under 0.31. */
  SAME_PERSON: 0.45,
  /** Faces smaller than this share of the photo's width are background people: they do not decide. */
  FACE_SHARE: 0.04,
};

interface Row {
  id: string;
  source: 'onedrive' | 'crowd';
  phash: Uint8Array | null;
  taken_at: Date | null;
  width: number | null;
  height: number | null;
  sharpness: number | null;
  review: 'pending' | 'approved' | 'rejected';
  created_at: Date;
  web_key: string | null;
  thumb_key: string | null;
  scene_key: string | null;
  onedrive_item_id: string | null;
}

const COLS = `id, source, phash, taken_at, width, height, sharpness, review, created_at, web_key, thumb_key, scene_key, onedrive_item_id`;

/**
 * Scene descriptions read from OneDrive, kept in memory while photos are compared (SCENE_CACHE_MB): a sync of 2 000
 * photos with 30 candidates each then reads each one about once. Only ever in this process's memory.
 */
class SceneCache {
  private map = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private max: () => number) {}
  get(key: string): Buffer | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: Buffer): void {
    if (v.length > this.max()) return;
    const had = this.map.get(key);
    if (had) {
      this.bytes -= had.length;
      this.map.delete(key);
    }
    this.map.set(key, v);
    this.bytes += v.length;
    while (this.bytes > this.max()) {
      const [k, old] = this.map.entries().next().value!;
      this.map.delete(k);
      this.bytes -= old.length;
    }
  }
  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}
let sceneMax = 256 * 1024 * 1024;
export const sceneCache = new SceneCache(() => sceneMax);
/** A scene description is at most this large (about 50 to 150 KB in practice). */
const SCENE_MAX_BYTES = 4 * 1024 * 1024;

/** Save a scene description to OneDrive and point the row at it (the earlier one is queued for deletion). */
async function saveScene(ctx: Ctx, eventId: string, mediaId: string, desc: Buffer, sharpness: number | null): Promise<string | null> {
  const key = await putCopy(ctx, eventId, mediaId, 's', desc, 'bin');
  const done = await ctx.db.query(
    `update media set scene_key = $2${sharpness == null ? '' : ', sharpness = $3'} where id = $1`,
    sharpness == null ? [mediaId, key] : [mediaId, key, sharpness],
  );
  if (!done.rowCount) {
    await forget(ctx, [key]);
    return null;
  }
  sceneCache.set(key, desc);
  emptyCopyTrashSoon(ctx);
  return key;
}

/**
 * Read (or make) a photo's scene description. Null when it cannot be made.
 * A sharpness worked out here is also put on `row`, so the choice between two frames below uses it.
 * It is made from the neutral copy of the photo (sceneCopy: no fix, no sharpening), as finishPhoto makes it: for a
 * photo without one (older, or its copy was deleted in OneDrive), from its original.
 */
async function sceneOf(ctx: Ctx, eventId: string, row: Pick<Row, 'id' | 'sharpness' | 'scene_key' | 'onedrive_item_id'>): Promise<Buffer | null> {
  sceneMax = ctx.cfg.sceneCacheBytes;
  // A description made earlier is used as it is, unless the photo's sharpness never got saved (then it is made again).
  if (row.sharpness != null && isDriveKey(row.scene_key)) {
    const hit = sceneCache.get(row.scene_key);
    if (hit) return hit;
    try {
      const desc = await readCopy(ctx, row.scene_key, SCENE_MAX_BYTES);
      sceneCache.set(row.scene_key, desc);
      return desc;
    } catch (e) {
      if (!(e instanceof DriveNotFoundError)) throw e; // OneDrive down: the decision waits
      // Deleted in OneDrive: made again below.
    }
  }
  if (!row.onedrive_item_id) return null;
  let neutral: Buffer | null = null;
  try {
    neutral = await withOriginal(ctx, row.onedrive_item_id, async (input) => sceneCopy((await prepare(input, ctx.cfg)).work));
  } catch (e) {
    if (['FaceDownError', 'DriveAuthError', 'DriveDownError', 'DriveBusyError'].includes((e as Error)?.name)) throw e;
    neutral = null;
  }
  if (!neutral) return null;
  const { desc, sharpness } = await ctx.face.scene(neutral);
  const key = await saveScene(ctx, eventId, row.id, desc, row.sharpness == null ? sharpness : null);
  if (row.sharpness == null) row.sharpness = sharpness;
  if (key) row.scene_key = key;
  await removeLegacy(ctx.cfg, [legacySceneKey(eventId, row.id)]);
  return desc;
}

/** Called by finishPhoto with the display copy in hand: the description is made once, while the bytes are there. */
export async function describeScene(ctx: Ctx, eventId: string, mediaId: string, web: Buffer): Promise<void> {
  sceneMax = ctx.cfg.sceneCacheBytes;
  const { desc, sharpness } = await ctx.face.scene(web);
  await saveScene(ctx, eventId, mediaId, desc, sharpness);
  await removeLegacy(ctx.cfg, [legacySceneKey(eventId, mediaId)]);
}

/** The people in the two photos are the same people. */
async function samePeople(q: Queryable, a: Row, b: Row, workMaxPx: number): Promise<boolean> {
  const load = async (r: Row) => {
    const rows = (await q.query<{ embedding: Uint8Array; box_w: number }>(`select embedding, box_w from faces where media_id = $1`, [r.id])).rows;
    // Face boxes are in the working copy's pixels (the original made at most workMaxPx on its long side).
    // Faces narrower than a small share of that width are people in the background: they do not decide.
    const long = Math.max(r.width ?? 0, r.height ?? 0);
    const workWidth = long ? (r.width ?? 0) * Math.min(1, workMaxPx / long) : 0;
    return rows.filter((f) => !workWidth || f.box_w >= workWidth * BURST.FACE_SHARE).map((f) => bufferToVector(toBuffer(f.embedding)!));
  };
  const fa = await load(a);
  const fb = await load(b);
  if (!fa.length && !fb.length) return true; // no people: the scene decides
  if (!fa.length || !fb.length) return false;
  const [small, large] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (large.length - small.length > Math.max(1, Math.round(large.length * 0.25))) return false;
  const dot = (x: Float32Array, y: Float32Array) => {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * y[i];
    return s;
  };
  const matched = small.filter((v) => large.some((w) => dot(v, w) >= BURST.SAME_PERSON)).length;
  return matched >= Math.ceil(small.length * 0.8);
}

/**
 * Of two same shots, the one to show: yours before a student's, then an approved one before one still waiting for
 * review (a new upload never takes down a photo students can already see), then clearly larger, then sharper, then
 * the earlier.
 */
function better(a: Row, b: Row): Row {
  if (a.source !== b.source) return a.source === 'onedrive' ? a : b;
  if ((a.review === 'approved') !== (b.review === 'approved')) return a.review === 'approved' ? a : b;
  const pa = (a.width ?? 0) * (a.height ?? 0);
  const pb = (b.width ?? 0) * (b.height ?? 0);
  if (pa > pb * 1.5) return a;
  if (pb > pa * 1.5) return b;
  const sa = a.sharpness ?? 0;
  const sb = b.sharpness ?? 0;
  if (Math.abs(sa - sb) > 0.1 * Math.max(sa, sb)) return sa > sb ? a : b;
  return a.created_at <= b.created_at ? a : b;
}

/**
 * Decide for one shown photo whether it is the same shot as other shown photos of the event. Every frame of the shot
 * goes into one decision: the better frame so far is compared with each further candidate, and whichever of the two
 * is better stays shown while the other becomes its copy (so three frames ready at the same moment end as one).
 * Returns the ids of the photos that are now copies (empty when none). Runs under the event's lock, so two decisions
 * never cross.
 */
export async function decideBurst(ctx: Ctx, eventId: string, mediaId: string): Promise<string[]> {
  if (!ctx.cfg.burstDuplicates) return [];
  return ctx.eventLock.run(eventId, async () => {
    const shown = `status = 'ready' and duplicate_of is null and not keep_both and type = 'photo' and review <> 'rejected' and web_key is not null`;
    const me = (await ctx.db.query<Row>(`select ${COLS} from media where id = $1 and ${shown}`, [mediaId])).rows[0];
    if (!me?.phash) return [];
    const mine = await sceneOf(ctx, eventId, me);
    if (!mine) return [];
    const all = (await ctx.db.query<Row>(`select ${COLS} from media where event_id = $1 and id <> $2 and ${shown} and phash is not null`, [eventId, mediaId])).rows;
    const myHash = toBuffer(me.phash)!;
    const candidates = all
      .map((r) => ({ r, bits: bitsApart(myHash, toBuffer(r.phash)!) }))
      .filter(({ r, bits }) => bits <= BURST.LOOSE_BITS || (me.taken_at && r.taken_at && Math.abs(+me.taken_at - +r.taken_at) <= BURST.SAME_MOMENT_MS))
      .sort((x, y) => x.bits - y.bits)
      .slice(0, BURST.MAX_CANDIDATES);
    const losers: string[] = [];
    let cur = me; // the frame shown so far
    let curScene = mine;
    for (const { r } of candidates) {
      const theirs = await sceneOf(ctx, eventId, r);
      if (!theirs) continue;
      const m = await ctx.face.compare(curScene, theirs);
      if (m.inliers < BURST.inliers || m.cover < BURST.cover || m.ncc < BURST.ncc) continue;
      if (!(await samePeople(ctx.db, cur, r, ctx.cfg.workMaxPx))) continue;
      const keep = better(cur, r);
      const lose = keep.id === cur.id ? r : cur;
      await ctx.db.tx(async (q) => {
        await markCopy(q, lose.id, keep.id);
        await q.query(`delete from faces where media_id = $1`, [lose.id]);
        await q.query(`update media set web_key = null, face_count = null where id = $1`, [lose.id]);
        await q.query(`update events set cover_media_id = $2 where cover_media_id = $1`, [lose.id, keep.id]);
        // A student who already found the copy keeps the photo: the match moves to the one that is shown.
        await q.query(
          `insert into matches (guest_id, media_id, similarity, tier, not_me)
             select guest_id, $2, similarity, tier, not_me from matches where media_id = $1
           on conflict (guest_id, media_id) do nothing`,
          [lose.id, keep.id],
        );
        await q.query(`delete from matches where media_id = $1`, [lose.id]);
      });
      // Its web copy left the row (the database queued it for deletion); a link handed out for it stops now.
      emptyCopyTrashSoon(ctx);
      await purgeKeys(ctx, [lose.web_key]);
      await removeLegacy(ctx.cfg, [lose.web_key]);
      losers.push(lose.id);
      if (keep.id !== cur.id) {
        cur = keep; // the better frame goes on, against the remaining candidates
        curScene = theirs;
      }
    }
    if (!losers.length) return [];
    ctx.bump(eventId);
    await mediaChanged(ctx, [...losers, cur.id]); // the copies leave the People folders, the shown one is filed
    return losers;
  });
}

/** Look through every shown photo of an event for same shots: for photos that were there before this rule. */
export async function findBursts(ctx: Ctx, eventId: string): Promise<number> {
  if (!ctx.cfg.burstDuplicates) return 0;
  const ids = (
    await ctx.db.query<{ id: string }>(`select id from media where event_id = $1 and status = 'ready' and duplicate_of is null and type = 'photo' order by created_at, id`, [eventId])
  ).rows.map((r) => r.id);
  let copies = 0;
  for (const id of ids) {
    try {
      copies += (await decideBurst(ctx, eventId, id)).length;
    } catch (e) {
      if ((e as Error)?.name === 'FaceDownError') throw e;
      ctx.log(`could not compare a photo for duplicates: ${(e as Error).message}`);
    }
  }
  return copies;
}
