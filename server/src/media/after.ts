import type { Ctx } from '../context.js';

/**
 * Call after anything that can change whether a photo or video is shown (it became ready, was approved, hidden,
 * rejected, marked as a copy, shown anyway, removed). Keeps the People folders in step. Passing a copy also looks at
 * the photo shown in its place, and passing a photo also looks at its copies (people/filing.ts). Never throws:
 * filing is retried by the next change or by "File again" in People. Then Keep me updated looks for the students who
 * kept their face for the event (keep/keep-updated.ts matchNewMedia).
 */
export async function mediaChanged(ctx: Ctx, mediaIds: string[]): Promise<void> {
  if (!mediaIds.length) return;
  try {
    const { filePeopleFor } = await import('../people/filing.js');
    await filePeopleFor(ctx, mediaIds);
  } catch (e) {
    ctx.log(`People folders: could not file ${mediaIds.length} item(s): ${(e as Error).message}`);
  }
  // Keep me updated: photos that are shown now are checked against the students' kept vectors (never throws).
  try {
    const { matchNewMedia } = await import('../keep/keep-updated.js');
    await matchNewMedia(ctx, mediaIds);
  } catch (e) {
    ctx.log(`Keep me updated: could not check ${mediaIds.length} item(s): ${(e as Error).message}`);
  }
}
