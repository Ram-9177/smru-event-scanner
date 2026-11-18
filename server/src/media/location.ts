import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Students get the best-quality original of a photo (Download all, Save original), byte for byte as it was taken,
 * except for one thing: where it was taken. A phone photo can carry the exact GPS position of the person who took
 * it, and that should not go to every other student who appears in it.
 *
 * The position is removed in place, in the file's own metadata: the GPS block of the EXIF data, and the GPS fields of
 * XMP. Nothing else changes: not one pixel is decoded or encoded again, the camera details, the date and the
 * orientation stay, and the file keeps its size. JPEG, PNG and WebP are handled.
 *
 * It fails closed: `cleanForHandover` says whether the original may go out as it is. Only when every block of
 * metadata in the file was read and nothing that says where (a GPS field under any name, a place name, a second
 * picture or a video appended to the file) is left. Otherwise the student gets the full-quality copy instead
 * (prepare.ts fullQuality), which carries only the camera, lens and date.
 */

/** Bytes of one value of each TIFF field type. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const GPS_POINTER = 0x8825;

/**
 * Remove the GPS block from a TIFF structure (EXIF data) in buf[start, end): the GPS fields and their values are
 * zeroed, and the pointer to them leaves the first directory. Returns true when there was one.
 */
function stripTiffGps(buf: Buffer, start: number, end: number): boolean {
  if (end - start < 8) return false;
  const order = buf.toString('latin1', start, start + 2);
  if (order !== 'II' && order !== 'MM') return false;
  const le = order === 'II';
  const u16 = (at: number) => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  const u32 = (at: number) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  const w16 = (at: number, v: number) => (le ? buf.writeUInt16LE(v, at) : buf.writeUInt16BE(v, at));
  const w32 = (at: number, v: number) => (le ? buf.writeUInt32LE(v, at) : buf.writeUInt32BE(v, at));
  const inside = (at: number, len: number) => at >= start && len >= 0 && at + len <= end;
  if (u16(start + 2) !== 42) return false;

  let changed = false;
  let ifd = u32(start + 4);
  // IFD0 holds the GPS pointer; the thumbnail's IFD1 is looked at too, in case a writer put one there.
  for (let level = 0; level < 2 && ifd; level++) {
    const at = start + ifd;
    if (!inside(at, 2)) break;
    let n = u16(at);
    if (!inside(at + 2, n * 12 + 4)) break;
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (u16(e) !== GPS_POINTER) continue;
      zeroGpsIfd(start + u32(e + 8));
      // Take the pointer out of the directory: later entries move up, the "next directory" offset follows them.
      const next = u32(at + 2 + n * 12);
      buf.copy(buf, e, e + 12, at + 2 + n * 12);
      n -= 1;
      w16(at, n);
      w32(at + 2 + n * 12, next);
      buf.fill(0, at + 2 + n * 12 + 4, at + 2 + n * 12 + 4 + 12);
      changed = true;
      i -= 1;
    }
    ifd = u32(at + 2 + n * 12);
  }
  return changed;

  function zeroGpsIfd(g: number): void {
    if (!inside(g, 2)) return;
    const n = u16(g);
    if (!inside(g + 2, n * 12)) return;
    for (let i = 0; i < n; i++) {
      const e = g + 2 + i * 12;
      const size = (TYPE_SIZE[u16(e + 2)] ?? 0) * u32(e + 4);
      if (size > 4) {
        const off = start + u32(e + 8);
        if (inside(off, size)) buf.fill(0, off, off + size); // the latitude, longitude, ... values
      }
    }
    buf.fill(0, g, g + 2 + n * 12 + (inside(g + 2 + n * 12, 4) ? 4 : 0));
  }
}

/** Blank the GPS fields of an XMP packet in buf[start, end) with spaces, so the XML stays valid and the same length. */
function stripXmpGps(buf: Buffer, start: number, end: number): boolean {
  const text = buf.toString('latin1', start, end);
  let changed = false;
  const blank = (s: string) => ((changed = true), ' '.repeat(s.length));
  const out = text
    .replace(/<(exif:GPS\w+)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/g, blank) // <exif:GPSLatitude>...</exif:GPSLatitude>
    .replace(/\sexif:GPS\w+\s*=\s*(?:"[^"]*"|'[^']*')/g, blank); // exif:GPSLatitude="..."
  if (changed) buf.write(out, start, 'latin1');
  return changed;
}

const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';

function stripJpeg(buf: Buffer): boolean {
  let changed = false;
  let at = 2;
  while (at + 4 <= buf.length && buf[at] === 0xff) {
    const marker = buf[at + 1];
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // the picture itself starts: metadata comes before it
    const len = buf.readUInt16BE(at + 2);
    const body = at + 4;
    const end = at + 2 + len;
    if (len < 2 || end > buf.length) break;
    if (marker === 0xe1) {
      if (buf.toString('latin1', body, body + 6) === 'Exif\0\0') changed = stripTiffGps(buf, body + 6, end) || changed;
      else if (buf.toString('latin1', body, body + XMP_ID.length) === XMP_ID) changed = stripXmpGps(buf, body + XMP_ID.length, end) || changed;
    }
    at = end;
  }
  return changed;
}

function stripPng(buf: Buffer): boolean {
  let changed = false;
  let at = 8;
  while (at + 12 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = at + 8;
    const end = data + len;
    if (end + 4 > buf.length) break;
    let touched = false;
    if (type === 'eXIf') touched = stripTiffGps(buf, data, end);
    else if (type === 'iTXt' && buf.toString('latin1', data, data + 18) === 'XML:com.adobe.xmp\0' && buf[data + 18] === 0) {
      // keyword, then compression flag 0 (not compressed), method, language\0, translated keyword\0, then the text
      let p = data + 20;
      for (let zeros = 0; zeros < 2 && p < end; p++) if (buf[p] === 0) zeros++;
      touched = stripXmpGps(buf, p, end);
    }
    if (touched) {
      buf.writeUInt32BE(zlib.crc32(buf.subarray(at + 4, end)) >>> 0, end);
      changed = true;
    }
    if (type === 'IEND') break;
    at = end + 4;
  }
  return changed;
}

function stripWebp(buf: Buffer): boolean {
  let changed = false;
  let at = 12;
  while (at + 8 <= buf.length) {
    const type = buf.toString('latin1', at, at + 4);
    const len = buf.readUInt32LE(at + 4);
    const data = at + 8;
    const end = data + len;
    if (end > buf.length) break;
    if (type === 'EXIF') {
      const tiff = buf.toString('latin1', data, data + 6) === 'Exif\0\0' ? data + 6 : data;
      changed = stripTiffGps(buf, tiff, end) || changed;
    } else if (type === 'XMP ') changed = stripXmpGps(buf, data, end) || changed;
    at = end + (len % 2);
  }
  return changed;
}

/** Remove where a photo was taken from its bytes, in place. Returns true when something was removed. */
export function stripLocation(buf: Buffer): boolean {
  try {
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return stripJpeg(buf);
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return stripPng(buf);
    if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return stripWebp(buf);
  } catch {
    /* metadata this code does not understand: the photo goes as it is */
  }
  return false;
}

/** The same for a photo file on this server (a downloaded original), rewritten only when something was removed. */
export async function stripLocationFromFile(file: string): Promise<boolean> {
  const buf = await fs.promises.readFile(file);
  if (!stripLocation(buf)) return false;
  await fs.promises.writeFile(file, buf);
  return true;
}

/** Anything left in metadata that could say where a photo was taken: GPS under any writer's name, or a place name. */
const PLACE = /gps|latitude|longitude|altitude|photoshop:(city|state|country)|iptc4xmp|location(created|shown)?\b|sub-?location|countrycode|\bcity\b/i;
const says = (buf: Buffer, start: number, end: number) => PLACE.test(buf.toString('latin1', start, end));

/** IPTC fields that name a place: location (2:26, 2:27), city, sub-location, state, country code and country. */
const IPTC_PLACE = new Set([26, 27, 90, 92, 95, 100, 101]);

/**
 * A Photoshop (APP13) block: its IPTC place names are blanked with spaces in place, and true when everything in it was
 * read and nothing else in it names a place.
 */
function cleanPhotoshop(buf: Buffer, start: number, end: number): boolean {
  const ID = 'Photoshop 3.0\0';
  if (buf.toString('latin1', start, start + ID.length) !== ID) return false;
  let at = start + ID.length;
  while (at + 12 <= end) {
    if (buf.toString('latin1', at, at + 4) !== '8BIM') return false;
    const id = buf.readUInt16BE(at + 4);
    const nameLen = buf[at + 6];
    const sizeAt = at + 6 + (((nameLen + 1) + 1) & ~1);
    if (sizeAt + 4 > end) return false;
    const size = buf.readUInt32BE(sizeAt);
    const data = sizeAt + 4;
    const stop = data + size;
    if (stop > end) return false;
    if (id === 0x0404) {
      // IPTC records: 0x1C, record, dataset, length (2 bytes), value
      for (let p = data; p < stop; ) {
        if (buf[p] === 0) {
          p++;
          continue;
        }
        if (buf[p] !== 0x1c || p + 5 > stop) return false;
        const record = buf[p + 1];
        const dataset = buf[p + 2];
        const len = buf.readUInt16BE(p + 3);
        if (len & 0x8000) return false; // an "extended" length: not used by phones or cameras
        const v = p + 5;
        if (v + len > stop) return false;
        if (record === 2 && IPTC_PLACE.has(dataset)) buf.fill(0x20, v, v + len);
        else if (says(buf, v, v + len)) return false;
        p = v + len;
      }
    } else if (id === 0x0424) {
      stripXmpGps(buf, data, stop); // XMP kept in the Photoshop block
      if (says(buf, data, stop)) return false;
    } else if (id !== 0x0409 && id !== 0x040c && says(buf, data, stop)) return false; // 0x0409/0x040C: the preview picture
    at = stop + (size & 1);
  }
  return true;
}

/** JPEG: every segment before the picture understood, and anything after it only more JPEG pictures, each clean. */
function cleanJpeg(buf: Buffer, from: number): number | null {
  let at = from + 2;
  let sawScan = false;
  while (at + 4 <= buf.length && buf[at] === 0xff) {
    const marker = buf[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9) return null; // no picture
    const len = buf.readUInt16BE(at + 2);
    const body = at + 4;
    const end = at + 2 + len;
    if (len < 2 || end > buf.length) return null;
    if (marker === 0xda) {
      sawScan = true; // the picture: the metadata is all before it
      break;
    }
    if (marker === 0xe1) {
      if (buf.toString('latin1', body, body + 6) === 'Exif\0\0') {
        stripTiffGps(buf, body + 6, end);
      } else if (buf.toString('latin1', body, body + XMP_ID.length) === XMP_ID) {
        stripXmpGps(buf, body + XMP_ID.length, end);
        if (says(buf, body + XMP_ID.length, end)) return null;
      } else return null; // extended XMP, or something else in APP1
    } else if (marker === 0xed) {
      if (!cleanPhotoshop(buf, body, end)) return null; // APP13: IPTC, whose place names go; anything unreadable fails
    }
    else if (marker === 0xe2 && buf.toString('latin1', body, body + 12) === 'ICC_PROFILE\0') {
      /* the colour profile */
    } else if (marker >= 0xe0 && marker <= 0xef) {
      if (says(buf, body, end)) return null;
    } else if (marker === 0xfe && says(buf, body, end)) return null; // a comment
    at = end;
  }
  // Stopped before the picture (stray bytes between two segments, a cut-off file): what comes after was not read.
  if (!sawScan) return null;
  // The end of the picture: FF D9 cannot appear inside its coded data (an FF there is always followed by 00 or a restart).
  const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), at);
  if (eoi < 0) return null;
  let next = eoi + 2;
  // A phone may append more pictures (an HDR gain map, a depth map, a preview): each must be clean too.
  // Anything else (a "motion photo" video, a maker's own trailer) cannot be checked.
  for (;;) {
    while (next < buf.length && buf[next] === 0) next++;
    if (next >= buf.length) return buf.length;
    if (next + 1 < buf.length && buf[next] === 0xff && buf[next + 1] === 0xd8) {
      const end = cleanJpeg(buf, next);
      if (end == null) return null;
      next = end;
    } else return null;
  }
}

const PNG_PLAIN = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'hIST', 'sPLT', 'cICP', 'mDCv', 'cLLi', 'acTL', 'fcTL', 'fdAT']);

function cleanPng(buf: Buffer): boolean {
  let at = 8;
  while (at + 12 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = at + 8;
    const end = data + len;
    if (end + 4 > buf.length) return false;
    if (type === 'IEND') return true;
    if (type === 'eXIf') {
      if (stripTiffGps(buf, data, end)) buf.writeUInt32BE(zlib.crc32(buf.subarray(at + 4, end)) >>> 0, end);
    } else if (type === 'iTXt' && buf.toString('latin1', data, data + 18) === 'XML:com.adobe.xmp\0' && buf[data + 18] === 0) {
      let p = data + 20;
      for (let zeros = 0; zeros < 2 && p < end; p++) if (buf[p] === 0) zeros++;
      if (stripXmpGps(buf, p, end)) buf.writeUInt32BE(zlib.crc32(buf.subarray(at + 4, end)) >>> 0, end);
      if (says(buf, p, end)) return false;
    } else if (type === 'iDOT') {
      if (len !== 28) return false; // Apple's offsets of the picture data, a fixed 28 bytes: nothing else may hide in it
    } else if (type === 'tIME') {
      /* when it was saved */
    } else if (type === 'tEXt') {
      if (/^raw profile type/i.test(buf.toString('latin1', data, Math.min(end, data + 80))) || says(buf, data, end)) return false;
    } else if (!PNG_PLAIN.has(type)) return false; // compressed text (zTXt, iTXt) and anything this code does not know
    at = end + 4;
  }
  return false;
}

const WEBP_PLAIN = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP', 'ANIM', 'ANMF']);

function cleanWebp(buf: Buffer): boolean {
  let at = 12;
  while (at + 8 <= buf.length) {
    const type = buf.toString('latin1', at, at + 4);
    const len = buf.readUInt32LE(at + 4);
    const data = at + 8;
    const end = data + len;
    if (end > buf.length) return false;
    if (type === 'EXIF') stripTiffGps(buf, buf.toString('latin1', data, data + 6) === 'Exif\0\0' ? data + 6 : data, end);
    else if (type === 'XMP ') {
      stripXmpGps(buf, data, end);
      if (says(buf, data, end)) return false;
    } else if (!WEBP_PLAIN.has(type)) return false;
    at = end + (len % 2);
  }
  return at >= buf.length;
}

/**
 * Take where a photo was taken out of its bytes, in place, and say whether the result may go to a student as it is:
 * true only for a JPEG, PNG or WebP whose every block of metadata was understood and is clean now. false: send the
 * full-quality copy instead (the buffer may have been partly cleaned; it is not to be sent).
 */
export function cleanForHandover(buf: Buffer): boolean {
  try {
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return cleanJpeg(buf, 0) != null;
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return cleanPng(buf);
    if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return cleanWebp(buf);
  } catch {
    /* metadata this code does not understand */
  }
  return false;
}

/** The same for a downloaded original on this server: cleaned in place, and true when it may be handed over as it is. */
export async function cleanFileForHandover(file: string): Promise<boolean> {
  const buf = await fs.promises.readFile(file);
  if (!cleanForHandover(buf)) return false;
  await fs.promises.writeFile(file, buf);
  return true;
}
