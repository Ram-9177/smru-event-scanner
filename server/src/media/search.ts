import type { Ctx } from '../context.js';
import { toBuffer } from '../db/index.js';
import { VISIBLE } from '../db/schema.js';

const DIM = 128;
const MAX_AGE_MS = 30_000;

interface EventIndex {
  version: number;
  builtAt: number;
  mediaIds: string[];
  vectors: Float32Array; // mediaIds.length * 128, each vector has length 1
  /** Where in a video each face is seen, in milliseconds (-1 for a photo). */
  atMs: Int32Array;
}

const indexes = new Map<string, EventIndex>();

/**
 * The faces of one event's VISIBLE photos, held in memory. Rebuilt when the event changes
 * (ctx.bump) and at least every 30 seconds, so a missed signal cannot keep it stale for long.
 * Faces are compared inside one event only: there is no index across events.
 */
async function eventIndex(ctx: Ctx, eventId: string): Promise<EventIndex> {
  const have = indexes.get(eventId);
  const version = ctx.version(eventId);
  if (have && have.version === version && Date.now() - have.builtAt < MAX_AGE_MS) return have;
  const rows = (
    await ctx.db.query<{ media_id: string; embedding: Uint8Array; at_ms: number | null }>(
      `select f.media_id, f.embedding, f.at_ms from faces f join media m on m.id = f.media_id
        where f.event_id = $1 and f.model = $2 and ${VISIBLE}`,
      [eventId, ctx.face.model],
    )
  ).rows;
  const vectors = new Float32Array(rows.length * DIM);
  const atMs = new Int32Array(rows.length);
  const mediaIds: string[] = [];
  rows.forEach((r, i) => {
    const b = toBuffer(r.embedding)!;
    for (let k = 0; k < DIM; k++) vectors[i * DIM + k] = b.readFloatLE(k * 4);
    mediaIds.push(r.media_id);
    atMs[i] = r.at_ms ?? -1;
  });
  const built = { version, builtAt: Date.now(), mediaIds, vectors, atMs };
  indexes.set(eventId, built);
  return built;
}

export interface Hit {
  mediaId: string;
  score: number;
  tier: 'sure' | 'maybe';
  /** A video: where in it the best-matching face is seen, in milliseconds. null for a photo. */
  atMs: number | null;
}

/** Compare one selfie vector with every face of the event; keep the best face per photo (or video) above the floor. */
export async function searchEvent(ctx: Ctx, eventId: string, selfie: Float32Array): Promise<Hit[]> {
  const { mediaIds, vectors, atMs } = await eventIndex(ctx, eventId);
  const best = new Map<string, { score: number; at: number }>();
  for (let i = 0, o = 0; i < mediaIds.length; i++, o += DIM) {
    let s = 0;
    for (let k = 0; k < DIM; k++) s += vectors[o + k] * selfie[k];
    if (s < ctx.cfg.faceMaybe) continue;
    const id = mediaIds[i];
    if (s > (best.get(id)?.score ?? -1)) best.set(id, { score: s, at: atMs[i] });
  }
  return [...best]
    .map(([mediaId, b]) => ({ mediaId, score: b.score, tier: tierOf(b.score, ctx.cfg.faceSure), atMs: b.at >= 0 ? b.at : null }))
    .sort((a, b) => b.score - a.score);
}

export const tierOf = (score: number, sure: number): 'sure' | 'maybe' => (score >= sure ? 'sure' : 'maybe');

export function forgetIndex(eventId: string): void {
  indexes.delete(eventId);
}
