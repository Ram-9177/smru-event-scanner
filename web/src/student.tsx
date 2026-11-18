import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError, clock, isVideo, niceDate, originalUrl, uploadFile, type Campus, type EventInfo, type KeepState, type Kind, type Me, type Photo, type RemovalState } from './lib/api';
import { pushBlock, subscribePush, unsubscribePush, type PushBlock } from './lib/push';
import { apiKey, under, useApi } from './lib/query';
import { qrPath } from './qr';
import { AlbumImg, Chips, edgeDate, flash, Icon, Lamp, Note, saveOriginals, tilt, UploadList, useFocusTrap, VideoBadge, Viewer, type UploadItem } from './ui';

/*
  The student side, as in the darkroom design (web/DESIGN.md):
  Find (/, /c/:campus, /e/:slug, /e/:slug/find): the red-lit room. The home shows one event as a big film frame (the
    latest; the others are under Earlier events), the selfie is a blank print on the drying line, the red shutter is the
    one thing to press. Each campus has its own home and its own link: /c/<campus>.
  Prints (/e/:slug/mine, /e/:slug/album): lights on. Your photos hang from pegs, the whole event is a contact sheet
    with your frames circled in red. /e/:slug/add and /e/:slug/me open the two dialogs over it.
  Photos are never tinted: every cover and thumbnail shows in true colour.
*/

/** The wording version of the consent line; the server stores which one the student saw. */
const CONSENT = 'v1';
const CONSENT_LINE = 'By taking a selfie you agree that we use it only to find photos of you from this event. The selfie is deleted right after the search. You can delete your results any time.';
const WORDMARK = 'Event Photos';
/** Keep me updated has its own consent, separate from the selfie's: its wording version, and the wording. */
const KEEP_CONSENT = 'k1';
const KEEP_LINE = "To do this we keep a code made from your face (never the selfie itself), for this event only, and check new photos against it. You can turn it off any time here. It is deleted when this event's face search ends.";
const ENDED = 'Face search ended — browse all photos';
const REMOVE_LINK = "Ask to remove me from this event's photos";

// ---- small helpers ---------------------------------------------------------------------------
const isOpen = (e: EventInfo | null | undefined): e is EventInfo => !!e && (e.state === 'live' || e.state === 'closed');
const num = (n: number | null | undefined) => Number(n || 0).toLocaleString('en-IN');
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const two = (n: number) => String(n).padStart(2, '0');
/** A landscape photo hangs on a wider print. */
const isWide = (p: Photo) => !!p.width && !!p.height && p.width > p.height * 1.12;
const matches = (q: string) => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches;
const coarse = () => matches('(pointer: coarse)');
const wide = () => matches('(min-width: 1000px)');
const canStream = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
/** Scrolls something into view, gently unless the student asked for less motion. */
function glide(el: Element | null | undefined, block: ScrollLogicalPosition) {
  if (!el || typeof el.scrollIntoView !== 'function') return;
  try {
    el.scrollIntoView({ block, behavior: matches('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth' });
  } catch {
    el.scrollIntoView(block !== 'end');
  }
}
/** "1 photo and 2 videos" */
const count = (items: Photo[]) => {
  const v = items.filter(isVideo).length;
  const p = items.length - v;
  return [p ? `${p} ${plural(p, 'photo', 'photos')}` : '', v ? `${v} ${plural(v, 'video', 'videos')}` : ''].filter(Boolean).join(' and ') || 'nothing';
};
const what = (p: Photo) => (isVideo(p) ? 'video' : 'photo');
/** Does the event run over more than one day? */
const several = (e: Pick<EventInfo, 'starts_on' | 'ends_on'>) => !!e.starts_on && !!e.ends_on && e.ends_on > e.starts_on;
/** The days of an event: "14 Nov 2026", or "14–16 Nov 2026" when it runs over several days. */
function days(e: Pick<EventInfo, 'starts_on' | 'ends_on'>): string {
  if (!several(e)) return niceDate(e.starts_on);
  const a = e.starts_on!;
  const b = e.ends_on!;
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  if (ya === yb && ma === mb) return `${da}–${niceDate(b)}`;
  return `${ya === yb ? niceDate(a).replace(/\s*\d{4}$/, '') : niceDate(a)} – ${niceDate(b)}`;
}

/**
 * The selfie just taken, so Prints can show it as the avatar to retake (and say when it had more than one face in it),
 * and so Keep me updated can be turned on without a second selfie. It lives in this tab's memory only, never in
 * storage, and its object URL is let go when a new one replaces it.
 */
let lastShot: { slug: string; url: string; mirror: boolean; faces?: number; blob?: Blob } | null = null;
function keepShot(s: typeof lastShot) {
  if (lastShot && lastShot.url !== s?.url) URL.revokeObjectURL?.(lastShot.url);
  lastShot = s;
}

/** The permanent address of the app (or of one campus's home): the one QR that works after every event. */
const homeLink = (campus?: string | null) => {
  const path = campus ? `/c/${encodeURIComponent(campus)}` : '/';
  return typeof window !== 'undefined' ? `${window.location.origin}${path}` : path;
};
/** "?campus=x": carried on an event's addresses opened from a campus home, so the way back stays on that campus. */
const campusQuery = (campus: string | null | undefined) => (campus ? `?campus=${encodeURIComponent(campus)}` : '');

/**
 * The order a home picks its one event in: open first, then the newest closed one that has photos, then opening soon,
 * then a closed one with no photos. So a draft set up for next month never hides last week's photos.
 */
const rankOf = (x: EventInfo): number =>
  x.state === 'live' ? 0 : x.state === 'closed' && x.photos > 0 ? 1 : x.state === 'draft' ? 2 : x.state === 'closed' ? 3 : 4;
/**
 * The event a home shows: the newest open one; if none is open, the newest closed one with photos; then the newest
 * opening soon; then any closed one. The server sends the list newest first (event date, then the order they were
 * made), so the first of the best rank wins.
 */
function currentOf(list: EventInfo[]): EventInfo | null {
  let best: EventInfo | null = null;
  for (const x of list) if (!best || rankOf(x) < rankOf(best)) best = x;
  return best;
}

/** A small paper note for small news (a toast), announced to screen readers. */
function useToast(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = useCallback((t: string) => {
    setText(t);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(null), 3600);
  }, []);
  return [
    <div key="toast" role="status" aria-live="polite">
      {text && <div className="toast">{text}</div>}
    </div>,
    show,
  ];
}

/** The ticket: the QR of the one permanent link (or of one campus's link) on a paper stub. */
function Ticket({ title, line, link = homeLink(), what = 'the Event Photos link', children }: { title: ReactNode; line: ReactNode; link?: string; what?: string; children?: ReactNode }) {
  const q = useMemo(() => qrPath(link), [link]);
  // A long campus link breaks before its "/c/…", not in the middle of the campus name.
  const shown = link.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/');
  return (
    <div className="ticket">
      {q && (
        <div className="ticket-qr">
          <svg viewBox={`0 0 ${q.size} ${q.size}`} shapeRendering="crispEdges" role="img" aria-label={`QR code of ${what}`}>
            <rect width="100%" height="100%" fill="#F4EEE3" />
            <path d={q.d} fill="#1B1210" />
          </svg>
        </div>
      )}
      <div className="ticket-tx">
        <div className="ticket-t">{title}</div>
        <div className="ticket-d">{line}</div>
        <div className="ticket-l">
          {shown.map((part, i) => (
            <Fragment key={i}>
              {i === 1 && <wbr />}
              {i > 0 && '/'}
              {part}
            </Fragment>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Copy or share the one link (Share where the phone can, otherwise Copy). */
function ShareLink({ toast }: { toast: (t: string) => void }) {
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;
  const go = async () => {
    const url = homeLink();
    if (canShare) return void navigator.share({ title: document.title, url }).catch(() => {});
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied.');
    } catch {
      toast(url);
    }
  };
  return (
    <div className="ticket-a">
      <button type="button" className="btn ink" onClick={go}>
        <Icon name={canShare ? 'share' : 'copy'} size={16} /> {canShare ? 'Share the link' : 'Copy the link'}
      </button>
    </div>
  );
}

// ---- the selfie as a JPEG ----------------------------------------------------------------------
async function toJpeg(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const scale = Math.min(1, 1280 / Math.max(w, h, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/jpeg', 0.9));
}
/** A picture from the phone's own camera, turned the right way up. */
async function fileToJpeg(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return await toJpeg(bmp, bmp.width, bmp.height);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((ok, no) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.onerror = () => no(new Error('unreadable'));
        im.src = url;
      });
      return await toJpeg(img, img.naturalWidth, img.naturalHeight);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// ---- Find: your event, show your face ---------------------------------------------------
interface EventsData {
  org: string | null;
  contact: string | null;
  events: EventInfo[];
}

/** The dashed outline of a head and shoulders on the blank print. */
function Silhouette() {
  return (
    <svg className="sil" viewBox="0 0 120 130" fill="none" stroke="#6B5B52" strokeWidth="2" strokeLinecap="round" strokeDasharray="5 6" aria-hidden>
      <circle cx="60" cy="58" r="25" />
      <path d="M14 130 C14 104 36 92 60 92 C84 92 106 104 106 130" />
    </svg>
  );
}

/** What a frame says about its event to a screen reader: title, days, photos, and your own. */
function frameLabel(e: EventInfo): string {
  const fresh = e.mine_new ?? 0;
  return [e.title, days(e), e.state === 'draft' ? 'opens soon' : `${num(e.photos)} ${plural(e.photos, 'photo', 'photos')}`, e.mine > 0 ? `${num(e.mine)} of you` : '', fresh > 0 ? `${num(fresh)} new` : ''].filter(Boolean).join(', ');
}

/** The home's one event as a big film frame: the date as edge print, its cover in true colour, a red count of your photos. */
function BigFrame({ e }: { e: EventInfo }) {
  const pic = e.cover ?? e.strip[0] ?? null;
  const fresh = e.mine_new ?? 0;
  return (
    <div className="fd-big" role="img" aria-label={frameLabel(e)}>
      <span className="edge-print">{edgeDate(e.starts_on)}</span>
      <span className="pic">{pic ? <AlbumImg src={pic} alt="" /> : <span className="none">{e.state === 'draft' ? 'Opens soon' : e.state === 'archived' ? 'Album closed' : 'No photos yet'}</span>}</span>
      {e.mine > 0 && <span className="got">{num(e.mine)}</span>}
      {fresh > 0 && <span className="fresh-mark">{num(fresh)} new</span>}
      {e.state === 'draft' && pic && <span className="soon">Soon</span>}
    </div>
  );
}

/** Earlier events: every other event of this home, newest first, on a paper card. */
function EarlierDialog({ list, latest, q, onClose }: { list: EventInfo[]; latest: EventInfo | null; q: string; onClose: () => void }) {
  return (
    <Dialog title="Earlier events" onClose={onClose}>
      <ul className="fd-evs">
        {list.map((x) => {
          const pic = x.cover ?? x.strip[0] ?? null;
          const [tag, kind] = x.state === 'draft' ? ['Soon', 'soon'] : x.state === 'closed' ? ['Closed', 'shut'] : x.state === 'archived' ? ['Album closed', 'shut'] : x === latest ? ['Latest', 'now'] : [null, ''];
          return (
            <li key={x.slug}>
              <Link className="fd-ev" to={`/e/${x.slug}${q}`} onClick={onClose} aria-label={[frameLabel(x), tag && tag !== 'Soon' ? tag.toLowerCase() : ''].filter(Boolean).join(', ')}>
                <span className="th">{pic ? <AlbumImg src={pic} alt="" loading="lazy" /> : <Icon name="image" size={18} />}</span>
                <span className="tx">
                  <span className="t">{x.title}</span>
                  <span className="m">
                    {days(x)}
                    {tag && <span className={`tag ${kind}`}>{tag}</span>}
                  </span>
                </span>
                {x.mine > 0 && (
                  <span className="mine">
                    {num(x.mine)} of you
                  </span>
                )}
                <Icon name="chev" size={18} />
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="row">
        <button type="button" className="btn ink" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

export function Find() {
  // A campus home is /c/<campus>; an event opened from it keeps the campus as ?campus=<campus>.
  const { slug: wanted, campus: campusPath } = useParams();
  const [params] = useSearchParams();
  const campus = campusPath ?? params.get('campus') ?? '';
  /** The old campus address (/?campus=x) is now that campus's own link. */
  const oldCampusLink = !wanted && !campusPath && !!params.get('campus');
  const q = campusQuery(campus);
  const homePath = campus ? `/c/${encodeURIComponent(campus)}` : '/';
  const nav = useNavigate();
  const qc = useQueryClient();

  // No campuses yet (or an older server): every campus link simply shows its events.
  const campuses = useApi<{ campuses: Campus[] }>('/campuses', { staleTime: 5 * 60_000 });
  const eventsQ = useApi<EventsData>(campus ? `/events?campus=${encodeURIComponent(campus)}` : '/events', { placeholderData: keepPreviousData });
  const named = campuses.data?.campuses.find((c) => c.slug === campus);
  /** A campus link that matches no campus: said on a slip, with the way to all the events. */
  const badCampus = !!campusPath && !!campuses.data && !named;
  // The server filters; the check here only matters while the previous campus's list is still on screen.
  const listed = (eventsQ.data?.events ?? []).filter((x) => !campus || x.campus === undefined || x.campus?.slug === campus);
  const inList = !!wanted && listed.some((x) => x.slug === wanted);
  // An unlisted event opened by its own link is shown all the same.
  const one = useApi<{ contact: string | null; event: EventInfo | null }>(`/e/${wanted ?? ''}`, { enabled: !!wanted && !!eventsQ.data && !inList, retry: false });
  const extra = !inList && one.data?.event ? one.data.event : null;
  const lookingUp = !!wanted && !!eventsQ.data && !inList && one.fetchStatus === 'fetching';
  // A campus link waits for the list of campuses, so a wrong one never shows "No events yet" first.
  const campusWait = !!campusPath && campuses.isPending;
  const events = eventsQ.data && !lookingUp && !campusWait ? (extra ? [extra, ...listed] : listed) : null;
  /** The home's own event: the latest (see currentOf). */
  const latest = events ? currentOf(listed) : null;
  // The event shown big: the one asked for by its address, otherwise the latest.
  const e = events ? (events.find((x) => x.slug === wanted) ?? latest ?? extra ?? null) : null;
  /** Every other event of this home, newest first, for Earlier events. */
  const others = events && e ? events.filter((x) => x !== e) : [];
  const [earlier, setEarlier] = useState(false);
  const closeEarlier = useCallback(() => setEarlier(false), []);
  const o = e?.options;
  const open = isOpen(e);
  const canFind = open && !!o?.find;
  /** The event's face data was deleted: no more selfies, the album stays. */
  const ended = open && !!e?.face_ended;
  const canAlbum = open && !!o?.album;
  const has = !!e && e.mine > 0;
  const contact = one.data?.contact ?? eventsQ.data?.contact ?? null;
  const base = e ? `/e/${e.slug}` : '/';
  /** The way to one of this event's screens, keeping the campus. */
  const to = (screen: string) => `${base}/${screen}${q}`;
  const loc = useLocation();
  const here = loc.pathname;
  const [toastNode, toast] = useToast();
  // Sent here after "Delete my results": said once, then the note is taken off the page's history entry so a reload
  // does not say it again.
  const deleted = !!(loc.state as { deleted?: boolean } | null)?.deleted;
  useEffect(() => {
    if (!deleted) return;
    toast('Your results were deleted.');
    nav(loc.pathname + loc.search, { replace: true, state: null });
  }, [deleted, toast, nav, loc.pathname, loc.search]);

  // ---- the camera ----
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const camRun = useRef(0);
  const [cam, setCam] = useState<'starting' | 'live' | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [shot, setShot] = useState(lastShot);
  const picker = useRef<HTMLInputElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const acts = useRef<HTMLDivElement>(null);
  const stepTwo = useRef<HTMLDivElement>(null);

  const stopCam = useCallback(() => {
    camRun.current++;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCam(null);
  }, []);
  useEffect(
    () => () => {
      camRun.current++;
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  useEffect(() => {
    window.addEventListener('pagehide', stopCam);
    return () => window.removeEventListener('pagehide', stopCam);
  }, [stopCam]);
  useEffect(() => {
    const v = video.current;
    if (cam !== 'live' || !v || !stream.current) return;
    v.srcObject = stream.current;
    void v.play()?.catch(() => {});
  }, [cam]);
  // Another event shown: the camera stops and the old message goes.
  const picked = e?.slug;
  useEffect(() => {
    stopCam();
    setMsg(null);
  }, [picked, stopCam]);

  // On a laptop the message slip sits under the drying line, near the fold: a new message (no face, camera
  // problem) is brought into view so it is not missed. On a phone it is already in the dock, in view.
  useEffect(() => {
    if (msg && wide()) glide(dock.current?.querySelector('.fd-msg'), 'nearest');
  }, [msg]);

  /** On a phone the buttons stay at the bottom; once there is a face to show, the print comes into view above them. */
  const revealPrint = () => {
    if (!wide()) glide(stepTwo.current, 'start');
  };

  const startCam = async () => {
    const run = ++camRun.current;
    const fail = (err: unknown) => {
      if (run !== camRun.current) return;
      const name = (err as { name?: string } | null)?.name;
      const denied = name === 'NotAllowedError' || name === 'SecurityError';
      setCam(null);
      setBlocked(true);
      setMsg(
        (denied ? 'The camera is blocked for this page. Allow it and try again, or ' : 'The camera could not start here. Try again, or ') +
          (coarse()
            ? 'tap the button once more to use your phone’s own camera. Opened from WhatsApp or Instagram? Open the page in Chrome or Safari.'
            : wide()
              ? 'scan the code and take the selfie on your phone.'
              : 'open this page on your phone and take the selfie there.'),
      );
    };
    if (!canStream()) return fail(null);
    setCam('starting');
    setMsg(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      if (run !== camRun.current) return s.getTracks().forEach((t) => t.stop());
      stream.current = s;
      setCam('live');
      setBlocked(false);
      revealPrint();
    } catch (err) {
      fail(err);
    }
  };

  /** The selfie goes straight to the search: no second step. */
  const send = async (blob: Blob, mirror: boolean) => {
    if (!e) return;
    const slug = e.slug;
    stopCam();
    const s: NonNullable<typeof lastShot> = { slug, url: URL.createObjectURL(blob), mirror, blob };
    keepShot(s);
    setShot(s);
    setBusy(true);
    setMsg(null);
    revealPrint();
    try {
      const out = await api<{ faces_in_selfie?: number }>(`/e/${slug}/selfie`, { body: blob, headers: { 'x-consent': CONSENT, 'content-type': 'image/jpeg' } });
      s.faces = out?.faces_in_selfie;
      // A new result: the old one must not show, even for a moment, and the counts elsewhere change too.
      qc.removeQueries({ queryKey: apiKey(`/e/${slug}/mine`) });
      void qc.invalidateQueries();
      nav(`/e/${slug}/mine${q}`, { state: { fresh: true } });
    } catch (err) {
      const x = err as ApiError;
      setBusy(false);
      if (x.code === 'face_off') return void nav(`/e/${slug}/album${q}`, { replace: true });
      setMsg(x.message || 'Something went wrong. Try again.');
      if (x.code === 'no_face' || x.code === 'no_selfie' || x.code === 'unreadable') {
        keepShot(null);
        setShot(null);
      }
    }
  };
  // One shot per tap: a double tap must not send the selfie twice while it is still being encoded.
  const taking = useRef(false);
  const capture = async () => {
    const v = video.current;
    if (!v || taking.current || busy) return;
    taking.current = true;
    flash();
    try {
      await send(await toJpeg(v, v.videoWidth || 640, v.videoHeight || 480), true);
    } catch {
      setMsg('That picture could not be read. Try again.');
    } finally {
      taking.current = false;
    }
  };
  const fromPhoneCamera = async (file: File | undefined) => {
    if (!file || !e) return;
    try {
      const jpeg = await fileToJpeg(file);
      flash();
      await send(jpeg, false);
    } catch {
      setMsg('That picture could not be read. Try again.');
    }
  };
  /** Is the consent line on screen right now? */
  const consentShown = () =>
    Array.from(document.querySelectorAll('.fd .privacy')).some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.top + 14 <= window.innerHeight;
    });
  /**
   * The red shutter, the blank print and the laptop's "Take a selfie" all land here. A phone opens its own camera,
   * a computer uses the webcam; neither offers stored pictures (someone else's picture must not open their photos).
   */
  const shoot = (fromPrint: boolean) => {
    if (!e || busy || !canFind || cam === 'starting') return;
    if (cam === 'live') return void capture();
    // A tap on the print while the consent line is off the screen only brings the buttons and that line into view.
    if (fromPrint && !consentShown()) return glide(wide() ? acts.current : dock.current, 'end');
    if (coarse() && (!wide() || blocked || !canStream())) picker.current?.click();
    else void startCam();
  };

  const shotHere = shot && e && shot.slug === e.slug ? shot : null;
  const shootDis = !canFind || busy || cam === 'starting';
  const shootSay = ended ? 'Search ended' : busy ? 'Developing…' : cam === 'live' ? 'Capture' : cam === 'starting' ? 'Starting…' : has ? 'Retake selfie' : 'Take selfie';
  const camOn = cam === 'live' || cam === 'starting';
  const say = !e ? 'your face here' : !open ? 'opens soon' : ended ? 'face search has ended' : !o?.find ? 'face search is off' : cam === 'starting' ? 'starting the camera…' : 'your face here';
  const addInRow = !!e && !!o?.upload;
  const addState = { back: here };

  const status = msg ? (
    <div className="slip bad fd-msg" role="alert">
      {msg}
    </div>
  ) : wanted && one.isError ? (
    <div className="slip fd-msg" role="status">
      That event could not be found. Here is the latest one.
    </div>
  ) : e?.state === 'archived' ? (
    <div className="slip fd-msg" role="status">
      <b>This album has closed.</b> {contact ? `If you need a photo from it, ask ${contact}.` : 'Ask the organiser if you need a photo from it.'}
    </div>
  ) : e && !open ? (
    <div className="slip fd-msg" role="status">
      Photos for this event are not open yet.{o?.upload ? ' You can already add the ones you took.' : ''}
    </div>
  ) : ended ? (
    <div className="slip fd-msg" role="status">
      {canAlbum ? <Link to={to('album')}>{ENDED}</Link> : 'Face search has ended for this event.'}
    </div>
  ) : e && open && !o?.find ? (
    <div className="slip fd-msg" role="status">
      Face search is switched off for this event. Use the full album.
    </div>
  ) : null;

  const lockLine = ended ? null : (
    <p className="privacy">
      <Icon name="lock" size={15} />
      <span>{CONSENT_LINE}</span>
    </p>
  );

  if (oldCampusLink) return <Navigate to={`/c/${encodeURIComponent(params.get('campus')!)}`} replace />;

  const hasEarlier = !badCampus && others.length > 0;
  const header = (
    <header className={`fd-top ${hasEarlier ? 'more' : ''}`}>
      <div className="fd-brand">
        <span className="wordmark">{WORDMARK}</span>
        <span className="orgname">{eventsQ.data?.org ?? "St. Mary's"}</span>
      </div>
      <div className="fd-topr">
        <span className="fd-nologin">No login · Nothing to install</span>
        {hasEarlier && (
          <button type="button" className="fd-earlier" aria-haspopup="dialog" aria-label="Earlier events" onClick={() => setEarlier(true)}>
            <Icon name="clock" size={18} />
            <span className="m">Earlier</span>
            <span className="d">Earlier events</span>
          </button>
        )}
        <Lamp />
      </div>
    </header>
  );
  /** The way in for organisers: a real button at the very bottom of the page. */
  const staff = (
    <p className="fd-staff">
      <Link className="btn ghost sm" to="/admin">
        For organisers
      </Link>
    </p>
  );

  if (badCampus) {
    return (
      <main className="room fd">
        <div className="glow" aria-hidden />
        {header}
        <div className="fd-bad">
          <div className="slip" role="alert">
            This campus link isn’t right.
          </div>
          <Link className="btn primary" to="/">
            See all events
          </Link>
        </div>
        {staff}
      </main>
    );
  }

  return (
    <main className="room fd">
      <div className="glow" aria-hidden />
      {header}

      <div className="fd-grid">
        <section className="fd-intro">
          <p className="fd-eyebrow hand" aria-hidden>
            scan · smile · take them home
          </p>
          <h1>Find every photo you’re in.</h1>
          <p className="fd-sub">
            <span className="m">Take a selfie, get your photos. No login, no app.</span>
            <span className="d">Show your face and your prints start developing. No login, nothing to install.</span>
          </p>
          {canAlbum && (
            <p className="fd-skip">
              <Link to={to('album')}>{e.photos === 1 ? 'Skip the selfie — see the 1 photo' : `Skip the selfie — see all ${num(e.photos)} photos`}</Link>
            </p>
          )}
        </section>

        <section className="fd-steps">
          <div className="stephead">
            <h2>
              <b>01</b>
              <span>Your event</span>
            </h2>
            {e && latest && e !== latest && (
              <Link className="linkbtn fd-latest" to={homePath}>
                See the latest event
              </Link>
            )}
          </div>
          <div className="fd-now">
            {!events ? (
              eventsQ.isError ? null : (
                <div className="fd-big ghost" aria-hidden>
                  <span className="pic" />
                </div>
              )
            ) : !e ? (
              <div className="fd-big" aria-hidden>
                <span className="pic">
                  <span className="none">Nothing yet</span>
                </span>
              </div>
            ) : (
              <BigFrame e={e} />
            )}
          </div>
          <div className="fd-cap">
            {!events ? (
              eventsQ.isError ? (
                <div className="slip bad" role="alert">
                  {eventsQ.error?.message ?? 'Something went wrong.'}{' '}
                  <button type="button" className="linkbtn fd-inline" onClick={() => void eventsQ.refetch()}>
                    Try again
                  </button>
                </div>
              ) : (
                <div role="status">
                  <div className="t">Loading the rolls…</div>
                  <div className="m">&nbsp;</div>
                </div>
              )
            ) : !e ? (
              <div>
                <h2 className="t">{named ? `No events at ${named.name} yet` : 'No events yet'}</h2>
                <div className="m">Photos show up here after the next event.</div>
              </div>
            ) : (
              <>
                <div>
                  <h2 className="t">{e.title}</h2>
                  <div className="m">{[days(e), e.campus?.name, e.venue, e.state === 'draft' ? 'photos soon' : `${num(e.photos)} ${plural(e.photos, 'photo', 'photos')}`].filter(Boolean).join(' · ')}</div>
                </div>
                {has && (
                  <Link className="fd-mine" to={to('mine')}>
                    My {num(e.mine)} {plural(e.mine, 'print', 'prints')} <Icon name="arrow" size={18} />
                  </Link>
                )}
              </>
            )}
          </div>

          <div className="stephead fd-two" ref={stepTwo}>
            <h2>
              <b>02</b>
              <span>Show your face</span>
            </h2>
          </div>
          <div className="fd-line">
            <i className="fd-nail" aria-hidden />
            <i className="fd-spare a" aria-hidden />
            <i className="peg fd-ga" aria-hidden />
            <i className="fd-spare b" aria-hidden />
            <i className="peg fd-gb" aria-hidden />
            <div className="fd-blank">
              <i className="peg" aria-hidden />
              <div className={`fd-bl ${shotHere || cam ? 'still' : ''}`}>
                <button type="button" className="fd-paper" onClick={() => shoot(true)} disabled={shootDis} aria-label={cam === 'live' ? 'Capture the selfie' : shotHere ? 'Your selfie: take it again' : 'The blank print: take a selfie'}>
                  <span className={`fd-well ${busy ? 'busy' : ''}`}>
                    {cam === 'live' ? (
                      <video ref={video} playsInline muted autoPlay />
                    ) : shotHere ? (
                      <>
                        <img className={shotHere.mirror ? 'flip' : undefined} src={shotHere.url} alt="Your selfie" />
                        {busy && <span className="veil hand">developing…</span>}
                      </>
                    ) : (
                      <>
                        <Silhouette />
                        <span className="say hand">{say}</span>
                      </>
                    )}
                  </span>
                </button>
              </div>
            </div>
            <div className="fd-acts" ref={acts}>
              {has && !camOn && (
                <Link className="btn primary" to={to('mine')}>
                  See my {num(e.mine)} {plural(e.mine, 'print', 'prints')}
                </Link>
              )}
              {cam === 'live' ? (
                <>
                  <button type="button" className="btn primary" onClick={() => void capture()} disabled={busy}>
                    <i className="shut-ring" aria-hidden />
                    <span>Capture</span>
                  </button>
                  <button type="button" className="btn ghost" onClick={stopCam}>
                    Cancel
                  </button>
                </>
              ) : ended && canAlbum ? (
                <Link className={`btn ${has ? 'ghost' : 'primary'} fd-ended`} to={to('album')}>
                  <Icon name="grid" size={20} />
                  <span>{ENDED}</span>
                </Link>
              ) : (
                <button type="button" className={`btn ${has ? 'ghost' : 'primary'}`} onClick={() => shoot(false)} disabled={shootDis}>
                  {has ? <Icon name="camera" size={20} /> : <i className="shut-ring" aria-hidden />}
                  <span>{busy ? 'Developing…' : cam === 'starting' ? 'Starting…' : has ? 'Retake selfie' : 'Take a selfie'}</span>
                </button>
              )}
              {lockLine}
            </div>
            <div className="fd-or hand" aria-hidden>
              or
            </div>
            <div className="fd-ticket">
              <i className="peg" aria-hidden />
              <div className="th">
                <Ticket
                  title={
                    <>
                      One code.
                      <br />
                      Every event.
                    </>
                  }
                  line="On a laptop? Scan to carry on from your phone."
                  link={homeLink(named?.slug)}
                  what={named ? `the ${named.name} campus link` : undefined}
                />
                <span className="hn hand" aria-hidden>
                  {named ? `${named.name} campus: same QR after every event` : 'same QR after every event'}
                </span>
              </div>
            </div>
          </div>

          {/* The dock: any message, the three controls and the consent line. On a phone it stays at the bottom. */}
          <div className="fd-dock" ref={dock}>
            {status}
            <div className="fd-ctls">
              {camOn ? (
                <button type="button" className="ctl" onClick={stopCam}>
                  <i>
                    <Icon name="xmark" />
                  </i>
                  <span>Cancel</span>
                </button>
              ) : addInRow ? (
                <Link className="ctl" to={to('add')} state={addState}>
                  <i>
                    <Icon name="plus" />
                  </i>
                  <span>Add photos</span>
                </Link>
              ) : (
                <span className="ctl none" aria-hidden />
              )}
              <button type="button" className="shutter" onClick={() => shoot(false)} disabled={shootDis}>
                <i aria-hidden />
                <span>{shootSay}</span>
              </button>
              {canAlbum ? (
                <Link className="ctl" to={to('album')} aria-label={`See all ${num(e.photos)} ${plural(e.photos, 'photo', 'photos')}${o?.album_locked ? ', needs the album passcode' : ''}`}>
                  <i>
                    <Icon name={o?.album_locked ? 'lock' : 'grid'} />
                  </i>
                  <span>See all {num(e.photos)}</span>
                </Link>
              ) : (
                <span className="ctl off" aria-hidden>
                  <i>
                    <Icon name="grid" />
                  </i>
                  <span>See all photos</span>
                </span>
              )}
            </div>
            {lockLine}
          </div>
          {e && o?.upload && (
            <Link className={`linkbtn fd-add ${addInRow ? 'wideonly' : ''}`} to={to('add')} state={addState}>
              + Add photos and videos you took at this event
            </Link>
          )}
        </section>
      </div>
      {staff}
      {/* The phone's own camera: on the page so a tap can open it, never seen. */}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        capture="user"
        className="fd-pick"
        tabIndex={-1}
        aria-hidden
        onChange={(ev) => {
          const f = ev.target.files?.[0];
          ev.target.value = '';
          void fromPhoneCamera(f);
        }}
      />
      {toastNode}
      {earlier && others.length > 0 && <EarlierDialog list={others} latest={latest} q={q} onClose={closeEarlier} />}
    </main>
  );
}

/** The old names of the find screens: the home page and the event page are Find with the latest or that event shown. */
export const Home = Find;
export const EventHome = Find;

// ---- Prints: your photos, and the whole event ------------------------------------------------
interface MineData {
  /** False while OneDrive is not giving the album's photos (older servers do not send it). */
  images_ok?: boolean;
  searched: boolean;
  new_photos: number;
  more_coming: boolean;
  download: boolean;
  sure: Photo[];
  maybe: Photo[];
  /** Keep me updated for this phone (older servers do not send it). */
  keep?: KeepState;
  /** This phone's latest removal request in the event. */
  removal?: RemovalState | null;
  /** Photos Keep me updated added that this phone has not seen yet. */
  fresh_count?: number;
}
interface AlbumPage {
  total: number;
  download: boolean;
  photos: Photo[];
  /** False while OneDrive is not giving the album's photos (older servers do not send it). */
  images_ok?: boolean;
}
type View = 'mine' | 'all';
type ListName = 'sure' | 'maybe' | 'all';

/** The server answers the session with a POST: it also starts this phone's visit to the event. */
function useSession(slug: string) {
  return useApi<{ event: EventInfo | null; me: Me; contact: string | null }>(`/e/${slug}/session`, {}, { json: {} });
}

function useInstallPrompt() {
  const [ready, setReady] = useState<any>((window as any).__installPrompt ?? null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      (window as any).__installPrompt = e;
      setReady(e);
    };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  return ready
    ? async () => {
        await ready.prompt();
        (window as any).__installPrompt = null;
        setReady(null);
      }
    : null;
}

const KINDS: { key: Kind; label: string }[] = [
  { key: 'solo', label: 'Solo' },
  { key: 'duo', label: 'Duo' },
  { key: 'group', label: 'Group' },
];

const PAGE = 60;

/** A print hanging from a peg: tap to open it, tick to select it. */
function PrintCell({ p, i, label, on, canTick, maybe, fresh, isNew, onOpen, onTick }: { p: Photo; i: number; label: string; on: boolean; canTick: boolean; maybe?: boolean; fresh?: boolean; isNew?: boolean; onOpen: () => void; onTick: () => void }) {
  const style = { '--r': `${tilt(p.id)}deg`, '--d': `${Math.min(i, 16) * 110}ms` } as CSSProperties;
  return (
    <div className={`pc ${isWide(p) ? 'w' : ''} ${on ? 'on' : ''}`} style={style}>
      <i className="peg" aria-hidden />
      <div className="pr-hang">
        <button type="button" className="print swing" onClick={onOpen} aria-label={label}>
          <AlbumImg src={p.thumb} alt="" loading="lazy" decoding="async" className={fresh ? 'devin' : undefined} />
          {isVideo(p) && <VideoBadge ms={p.duration_ms} />}
        </button>
        {canTick && (
          <button type="button" className="tick" aria-pressed={on} aria-label={`Select ${what(p)} ${i + 1}`} onClick={onTick}>
            <i>
              <Icon name="check" size={15} />
            </i>
          </button>
        )}
        {maybe && (
          <span className="q hand" aria-hidden>
            ?
          </span>
        )}
        {isNew && (
          <span className="new-mark" aria-hidden>
            New
          </span>
        )}
      </div>
    </div>
  );
}

/** A print still developing: an empty paper well, pulsing, with a handwritten "developing…". */
function DevCell({ k }: { k: number }) {
  return (
    <div className={`pc dev ${k % 3 === 2 ? 'w' : ''}`} style={{ '--r': `${tilt(`dev${k}`)}deg` } as CSSProperties} aria-hidden>
      <i className="peg" />
      <div className="pr-hang">
        <div className="print">
          <span className="pp" />
        </div>
        <span className="lab hand">developing…</span>
      </div>
    </div>
  );
}

export function Prints() {
  const { slug = '' } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const seg = loc.pathname.split('/').filter(Boolean).pop();
  const dialog = seg === 'add' ? 'add' : seg === 'me' ? 'me' : null;
  const routeView: View | null = seg === 'album' ? 'all' : seg === 'mine' ? 'mine' : null;
  const [lastView, setLastView] = useState<View | null>(routeView);
  useEffect(() => {
    if (routeView) setLastView(routeView);
  }, [routeView]);
  const nav_state = (loc.state ?? {}) as { fresh?: boolean; back?: string };
  const [toastNode, toast] = useToast();
  const install = useInstallPrompt();

  const session = useSession(slug);
  const ev = session.data?.event ?? null;
  const me = session.data?.me;
  const contact = session.data?.contact ?? null;
  const open = isOpen(ev);
  const o = ev?.options;
  const view: View = routeView ?? lastView ?? (me?.searched || !o?.album ? 'mine' : 'all');
  const minePath = `/e/${slug}/mine`;
  const albumPath = `/e/${slug}/album`;
  // Opened from a campus home: the campus stays on every address here, so the way back leads to that campus.
  const [params] = useSearchParams();
  const q = campusQuery(params.get('campus'));
  const minePage = minePath + q;
  const albumPage = albumPath + q;
  const findPage = `/e/${slug}${q}`;

  // Your results load straight away on My prints; on All photos they circle your frames (no result is fine).
  const mineQ = useApi<MineData>(minePath, { enabled: view === 'mine' || open });
  const data = mineQ.data;
  const album = useInfiniteQuery({
    queryKey: apiKey(albumPath),
    queryFn: ({ pageParam }) => api<AlbumPage>(`${albumPath}?offset=${pageParam}&limit=${PAGE}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const have = pages.reduce((n, p) => n + p.photos.length, 0);
      return last.photos.length > 0 && have < last.total ? have : undefined;
    },
    enabled: view === 'all' && open && !!o?.album,
  });
  const photos = useMemo(() => album.data?.pages.flatMap((p) => p.photos) ?? [], [album.data]);
  const lastPage = album.data?.pages.at(-1);
  const total = lastPage?.total ?? null;
  const albumFail = album.error as ApiError | null;
  const locked = albumFail?.code === 'passcode_needed';

  // ---- what is picked, and the downloads ----
  const [picked, setPicked] = useState<Record<string, Photo>>({});
  const [saved, setSaved] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind | ''>('');
  const [showMaybe, setShowMaybe] = useState(false);
  const [openAt, setOpenAt] = useState<{ list: ListName; index: number } | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The prints Keep me updated added since the last visit keep their New mark for this whole visit, even after the
  // server has been told they were seen.
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(() => new Set());
  // Another event: start again.
  useEffect(() => {
    setPicked({});
    setSaved(false);
    setKind('');
    setShowMaybe(false);
    setOpenAt(null);
    setRemoving(false);
    setFreshIds(new Set());
  }, [slug]);
  const togglePick = useCallback((p: Photo) => {
    setSaved(false);
    setPicked((cur) => {
      const next = { ...cur };
      if (next[p.id]) delete next[p.id];
      else next[p.id] = p;
      return next;
    });
  }, []);
  const onIndex = useCallback((i: number) => setOpenAt((v) => (v ? { ...v, index: i } : v)), []);
  const onClose = useCallback(() => setOpenAt(null), []);

  // All · Solo · Duo · Group: how many of the main people are in each. Empty ones do not show.
  const sureAll = data?.sure ?? [];
  const maybeAll = data?.maybe ?? [];
  const every = [...sureAll, ...maybeAll];
  const kinds = KINDS.map((k) => ({ ...k, count: every.filter((p) => p.kind === k.key).length })).filter((k) => k.count > 0);
  const showKinds = kinds.length > 1 || (kinds.length === 1 && kinds[0].count < every.length);
  const byKind = (items: Photo[]) => (kind && showKinds ? items.filter((p) => p.kind === kind) : items);
  const sure = byKind(sureAll);
  const maybe = byKind(maybeAll);
  const mineIds = useMemo(() => new Set((data?.sure ?? []).map((p) => p.id)), [data]);

  // New photos from Keep me updated: marked, then (once the screen has shown them for a moment) seen.
  const freshNow = useMemo(() => (data?.sure ?? []).filter((p) => p.fresh).map((p) => p.id), [data]);
  const anyFresh = view === 'mine' && (freshNow.length > 0 || (data?.fresh_count ?? 0) > 0);
  useEffect(() => {
    if (!freshNow.length) return;
    setFreshIds((cur) => (freshNow.every((id) => cur.has(id)) ? cur : new Set([...cur, ...freshNow])));
  }, [freshNow]);
  useEffect(() => {
    if (!anyFresh) return;
    const t = window.setTimeout(() => {
      api(`/e/${slug}/mine/seen`, { method: 'POST', json: {} })
        .then(() => void qc.invalidateQueries(under('/events')))
        .catch(() => {});
    }, 1200);
    return () => window.clearTimeout(t);
  }, [anyFresh, data, slug, qc]);
  const freshCount = Math.max(data?.fresh_count ?? 0, sureAll.filter((p) => freshIds.has(p.id)).length);
  const keep = data?.keep;
  const removal = data?.removal ?? null;
  const setMine = useCallback((patch: Partial<MineData>) => qc.setQueryData<MineData>(apiKey(minePath), (d) => (d ? { ...d, ...patch } : d)), [qc, minePath]);
  /** Remove me is offered while there are sure matches and no request is waiting. */
  const canRemove = open && !!data?.searched && sureAll.length > 0 && removal?.status !== 'open';
  const list = openAt ? (openAt.list === 'sure' ? sure : openAt.list === 'maybe' ? maybe : photos) : [];

  const n = Object.keys(picked).length;
  const canDl = view === 'all' ? !!lastPage?.download : !!data?.download;
  const anyDl = !!data?.download || !!lastPage?.download;
  const showBar = !!working || (canDl && sureAll.length > 0) || (n > 0 && anyDl);
  const barLabel = working ?? (saved ? `${num(n || sureAll.length)} ${plural(n || sureAll.length, 'photo', 'photos')} saved` : n ? `Download ${num(n)} selected` : view === 'all' ? `Download my ${num(sureAll.length)}` : `Download all ${num(sureAll.length)}`);

  /** Download all: the server makes a ZIP of your photos in full quality and hands back a short-lived link. */
  const downloadAll = async () => {
    setWorking('Preparing…');
    try {
      const { url } = await api<{ url: string }>(`/e/${slug}/zip`, { json: {} });
      setSaved(true);
      window.location.href = url;
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setWorking(null);
    }
  };
  /** The ticked ones in full quality: to the phone's gallery through its share sheet where it can, else one by one. */
  const downloadPicked = async () => {
    const items = Object.values(picked);
    const { trouble, cancelled } = await saveOriginals(
      items.map((p, i) => ({ url: originalUrl(slug, p.id), name: `${slug}-${two(i + 1)}.${isVideo(p) ? 'mp4' : 'jpg'}` })),
      (done) => setWorking(`Saving ${done + 1} of ${items.length}…`),
    );
    setWorking(null);
    if (cancelled) return;
    if (trouble) toast(items.length > 1 ? `Some could not be saved. ${trouble}` : trouble);
    else setSaved(true);
  };

  const notMe = async (p: Photo) => {
    try {
      await api(`${minePath}/${p.id}/not-me`, { method: 'POST' });
      qc.setQueryData<MineData>(apiKey(minePath), (d) => (d ? { ...d, sure: d.sure.filter((x) => x.id !== p.id), maybe: d.maybe.filter((x) => x.id !== p.id) } : d));
      // The counts on the event and the events list change with it.
      void qc.invalidateQueries({ queryKey: apiKey(`/e/${slug}/session`) });
      void qc.invalidateQueries(under('/events'));
      setPicked((cur) => {
        const next = { ...cur };
        delete next[p.id];
        return next;
      });
      setOpenAt(null);
      toast('Removed from your prints.');
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!code || checking) return;
    setCodeError(null);
    setChecking(true);
    try {
      await api(`/e/${slug}/session`, { json: { passcode: code } });
      void qc.invalidateQueries({ queryKey: apiKey(`/e/${slug}/session`) });
      await album.refetch();
    } catch (err) {
      setCodeError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  // ---- the dialogs ----
  const fallback = me?.searched ? minePage : o?.album ? albumPage : findPage;
  const closeDialog = () => {
    if (nav_state.back) nav(-1);
    else nav(lastView === 'all' ? albumPage : lastView === 'mine' ? minePage : fallback, { replace: true });
  };
  const dialogState = { back: loc.pathname };

  // ---- where this screen sends you instead ----
  // After face search ended (the event's face data was deleted) the results found before stay on My prints.
  const mineOn = !!o?.find || (!!ev?.face_ended && !!me?.searched);
  if (!dialog && view === 'mine' && ev && open && !mineOn && o!.album) return <Navigate to={albumPage} replace />;
  if (!dialog && view === 'all' && ev && open && !o!.album) return <Navigate to={minePage} replace />;
  if (!dialog && view === 'mine' && data && !data.searched) return <Navigate to={`/e/${slug}/find${q}`} replace />;

  // ---- the hero ----
  const shotHere = lastShot && lastShot.slug === slug ? lastShot : null;
  const fresh = !!nav_state.fresh;
  const mineLoading = view === 'mine' && !data && !mineQ.isError;
  const failed = (view === 'mine' && mineQ.isError && !data ? mineQ.error : null) ?? (session.isError && !session.data ? session.error : null);
  let h1: string;
  let note = '';
  const slips: ReactNode[] = [];
  if (failed) {
    h1 = 'Something went wrong.';
    slips.push(
      <div key="err" className="slip bad" role="alert">
        {failed.message || 'Something went wrong.'}{' '}
        <button
          type="button"
          className="linkbtn pr-inline"
          onClick={() => {
            void session.refetch();
            if (view === 'mine') void mineQ.refetch();
          }}
        >
          Try again
        </button>
      </div>,
    );
  } else if (session.data && !ev) {
    h1 = 'This album has closed.';
    slips.push(
      <div key="closed" className="slip" role="status">
        {contact ? `If you need a photo from it, ask ${contact}.` : 'Ask the organiser if you need a photo from it.'}
      </div>,
    );
  } else if (ev && !open) {
    h1 = 'Not open yet.';
    note = 'the photos for this event open soon';
  } else if (view === 'mine') {
    if (mineLoading || !data) {
      h1 = 'Developing…';
      note = 'finding the photos you are in';
    } else if (sureAll.length) {
      h1 = `${num(sureAll.length)} ${plural(sureAll.length, 'print', 'prints')} of you.`;
      note = data.more_coming ? `${count(sureAll)} ready · more still developing…` : `${count(sureAll)}, ${sureAll.length === 1 ? 'ready' : 'all ready'}`;
    } else {
      h1 = 'No prints of you yet.';
      note = data.more_coming ? 'more photos are still developing…' : 'we could not find you on this roll';
      slips.push(
        ev?.face_ended ? (
          // No more selfies here: the album is the way on.
          <div key="none" className="slip" role="status">
            {o?.album ? <Link to={albumPage}>{ENDED}</Link> : 'Face search has ended for this event.'}
          </div>
        ) : (
          <div key="none" className="slip" role="status">
            Try another selfie in good light, without sunglasses or a mask{o?.album ? <>, or look through <Link to={albumPage}>all the photos</Link></> : null}.
          </div>
        ),
      );
    }
    if (data && shotHere?.faces && shotHere.faces > 1) {
      slips.push(
        <div key="faces" className="slip" role="status">
          We found {shotHere.faces} faces in your selfie and searched for the biggest one. For your own photos, take the selfie alone.
        </div>,
      );
    }
    if (data && freshCount > 0) {
      slips.push(
        <div key="fresh" className="slip" role="status">
          {num(freshCount)} new {plural(freshCount, 'photo', 'photos')} of you arrived since your last visit.
        </div>,
      );
    }
    if (data && data.new_photos > 0 && keep?.on) {
      slips.push(
        <div key="new" className="slip" role="status">
          We're checking new photos for you.
        </div>,
      );
    } else if (data && data.new_photos > 0 && o?.find) {
      slips.push(
        <div key="new" className="slip" role="status">
          {num(data.new_photos)} new {plural(data.new_photos, 'photo was', 'photos were')} added since your selfie. <Link to={findPage}>Retake it</Link> to check them.
        </div>,
      );
    }
    if (data && removal) {
      slips.push(
        <div key="removal" className="slip" role="status">
          {removal.status === 'open'
            ? 'Your removal request is waiting. The organisers will check it soon.'
            : removal.status === 'approved'
              ? 'Done. The photos you asked about are no longer in the album.'
              : `The organisers kept these photos.${contact ? ` Ask ${contact} if you have questions.` : ''}`}
        </div>,
      );
    }
  } else {
    h1 = total !== null && !locked ? `All ${num(total)} ${plural(total, 'photo', 'photos')}.` : album.isPending && !locked ? 'Loading the roll…' : 'All the photos.';
    note = 'the whole event, frame by frame';
  }

  // ---- the body ----
  const printLabel = (p: Photo, i: number, yours: boolean, isNew = false) => `Open ${what(p)} ${i + 1}${yours ? ', one of yours' : ''}${isNew ? ', new' : ''}${isVideo(p) && p.duration_ms ? `, ${clock(p.duration_ms)} long` : ''}`;
  const slot =
    o?.upload && !failed ? (
      <div className="pr-slot">
        <i className="peg" aria-hidden />
        <Link to={`/e/${slug}/add${q}`} state={dialogState}>
          <span className="st">
            <Icon name="plus" size={20} />
            <span>Hang your shots</span>
          </span>
          <span className="sd">Took photos or videos at this event? Add them to the roll. Copies already on it are skipped.</span>
        </Link>
      </div>
    ) : null;

  let body: ReactNode = null;
  if (!failed && ev && !open) {
    body = slot ? <div className="pr-line">{slot}</div> : null;
  } else if (!failed && view === 'mine' && (open || !session.data)) {
    const cells: ReactNode[] = [];
    if (mineLoading) for (let k = 0; k < 6; k++) cells.push(<DevCell key={`d${k}`} k={k} />);
    else if (data) {
      sure.forEach((p, i) =>
        cells.push(<PrintCell key={p.id} p={p} i={i} label={printLabel(p, i, true, freshIds.has(p.id))} on={!!picked[p.id]} canTick={data.download} fresh={fresh} isNew={freshIds.has(p.id)} onOpen={() => setOpenAt({ list: 'sure', index: i })} onTick={() => togglePick(p)} />),
      );
      if (data.more_coming) [1, 2].forEach((k) => cells.push(<DevCell key={`d${k}`} k={k} />));
    }
    body = (
      <>
        {showKinds && (
          <div className="pr-kinds">
            <Chips
              label="Who is in them"
              value={kind}
              onChange={(k) => (setKind(k), setOpenAt(null))}
              items={[{ key: '' as const, label: `All (${every.length})` }, ...kinds.map((k) => ({ key: k.key, label: `${k.label} (${k.count})` }))]}
            />
          </div>
        )}
        {data && sureAll.length > 0 && sure.length === 0 && <p className="pr-quiet pr-padx">None of your sure matches are in this group.</p>}
        {(cells.length > 0 || (!mineLoading && slot)) && (
          <div className="pr-line" aria-label={data ? 'Your prints' : undefined} role={data ? 'region' : undefined}>
            {cells}
            {!mineLoading && slot}
          </div>
        )}
        {data && maybe.length > 0 && (
          <section className="pr-maybe" aria-labelledby="maybe-h">
            <div className="pr-maybe-h">
              <h2 id="maybe-h" className="hand">
                Might be you ({maybe.length})
              </h2>
              <button type="button" className="btn sm ghost" aria-expanded={showMaybe} aria-controls="maybe-line" onClick={() => setShowMaybe((s) => !s)}>
                {showMaybe ? 'Hide' : 'Show'}
              </button>
            </div>
            {showMaybe && (
              <div id="maybe-line">
                <p className="pr-quiet">Less certain matches. Open one and tap “Not me” if it is someone else.</p>
                <div className="pr-line">
                  {maybe.map((p, i) => (
                    <PrintCell key={p.id} p={p} i={i} label={printLabel(p, i, false)} on={!!picked[p.id]} canTick={data.download} maybe onOpen={() => setOpenAt({ list: 'maybe', index: i })} onTick={() => togglePick(p)} />
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </>
    );
  } else if (!failed && view === 'all' && open) {
    if (locked) {
      body = (
        <form className="gate pr-gate" onSubmit={unlock}>
          <h2>This album has a passcode</h2>
          <p>The organiser shares it with the people who were at the event.</p>
          <label htmlFor="passcode">Album passcode</label>
          <input id="passcode" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus />
          {codeError && (
            <p className="err" role="alert">
              {codeError}
            </p>
          )}
          <div>
            <button className="btn primary" disabled={!code || checking}>
              <Icon name="grid" size={18} /> {checking ? 'Checking…' : 'Open the album'}
            </button>
          </div>
        </form>
      );
    } else if (albumFail && !album.isFetching && !photos.length) {
      body = (
        <div className="pr-pad">
          <div className="slip bad" role="alert">
            {albumFail.message}{' '}
            <button type="button" className="linkbtn pr-inline" onClick={() => void album.refetch()}>
              Try again
            </button>
          </div>
        </div>
      );
    } else if (album.data) {
      const left = (total ?? 0) - photos.length;
      body = (
        <section className="sheet pr-sheet" aria-label="Contact sheet">
          <div className="sheet-head">
            <span className="pr-sh-a">
              <span>{ev?.title} · contact sheet</span>
              {mineIds.size > 0 && <span className="hand">circled in red = you</span>}
            </span>
            <span>{photos.length ? `1–${num(photos.length)} of ${num(total)}` : 'No photos yet'}</span>
          </div>
          {photos.length ? (
            <div className="pr-frames">
              {photos.map((p, i) => {
                const yours = mineIds.has(p.id);
                return (
                  <button key={p.id} type="button" className={`cf ${yours ? 'me' : ''} ${picked[p.id] ? 'on' : ''}`} style={{ '--r': `${tilt(p.id, 6)}deg` } as CSSProperties} onClick={() => setOpenAt({ list: 'all', index: i })} aria-label={printLabel(p, i, yours)}>
                    <span className="no" aria-hidden>
                      <i className="tri" />
                      {two(i + 1)}
                    </span>
                    <AlbumImg src={p.thumb} alt="" loading="lazy" decoding="async" />
                    {isVideo(p) && <VideoBadge ms={p.duration_ms} />}
                    <i className="circ" aria-hidden />
                    <i className="chk" aria-hidden>
                      <Icon name="check" size={14} />
                    </i>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="pr-empty">No photos here yet. They show up as the organiser adds them.</p>
          )}
          {album.isFetchNextPageError && (
            <div className="slip bad" role="alert">
              {albumFail?.message ?? 'The next frames could not be loaded.'}
            </div>
          )}
          {left > 0 && (
            <div className="pr-more">
              <button type="button" className="btn ink" onClick={() => void album.fetchNextPage()} disabled={album.isFetchingNextPage}>
                {album.isFetchingNextPage ? 'Loading…' : `Load the next ${num(Math.min(left, PAGE))} ${plural(Math.min(left, PAGE), 'frame', 'frames')}`}
              </button>
            </div>
          )}
        </section>
      );
    } else {
      body = (
        <div className="pr-pad" role="status">
          <span className="spin" aria-hidden /> <span className="pr-quiet">Loading…</span>
        </div>
      );
    }
  }

  // ---- top, tools, foot ----
  const tabs =
    open && mineOn && o!.album ? (
      <nav className="seg pr-seg" aria-label="Which photos">
        <Link to={minePage} aria-current={view === 'mine' ? 'page' : undefined}>
          My prints{data ? ` · ${num(sureAll.length)}` : ''}
        </Link>
        <Link to={albumPage} aria-current={view === 'all' ? 'page' : undefined}>
          {o!.album_locked && (locked || !me?.album_open) && <Icon name="lock" size={15} />}
          All photos · {num(total ?? ev!.photos)}
        </Link>
      </nav>
    ) : null;
  const bar = showBar ? (
    <div className="pr-acts">
      {n > 0 && !working && (
        <button type="button" className="btn ghost" onClick={() => (setPicked({}), setSaved(false))}>
          Clear
        </button>
      )}
      <button type="button" className={`btn ${saved && !working ? 'done' : 'primary'}`} onClick={() => void (n ? downloadPicked() : downloadAll())} disabled={!!working}>
        <Icon name={saved && !working ? 'check' : 'download'} size={22} />
        <span>{barLabel}</span>
      </button>
    </div>
  ) : null;
  const hint = view === 'all' ? `Click a frame to open it${anyDl ? ' and select the ones you want.' : '.'}` : `Click a print to open it.${canDl ? ' Tick the ones you want, or take the lot in full quality.' : ''}`;
  const downloadsOff = open && ((data && !data.download) || (lastPage && !lastPage.download));
  // OneDrive is not giving the photos for a moment: said once, above the frames (they try again by themselves).
  const imagesDown = open && (view === 'all' ? lastPage?.images_ok === false : data?.images_ok === false);

  return (
    <main className={`pr ${showBar ? 'has-bar' : ''}`}>
      <header className="pr-top">
        <div className="l">
          <Link className="back" to={findPage} aria-label="Back to events">
            <Icon name="arrowback" size={24} />
          </Link>
          <span className="wordmark">{WORDMARK}</span>
          <span className="edge-print lg">
            <span>{[ev?.title, ev ? (several(ev) ? days(ev) : edgeDate(ev.starts_on)) : ''].filter(Boolean).join(' · ') || ' '}</span>
          </span>
        </div>
        {open && o!.find && (
          <Link className="retake" to={findPage} aria-label="Retake selfie">
            <span className="av">{shotHere ? <img className={shotHere.mirror ? 'flip' : undefined} src={shotHere.url} alt="" /> : <Icon name="camera" size={20} />}</span>
            <span className="lbl">Retake selfie</span>
          </Link>
        )}
      </header>

      <div className="pr-hero">
        <h1>{h1}</h1>
        {note && <p className="note hand">{note}</p>}
        {slips}
      </div>
      {imagesDown && (
        <p className="images-down" role="status">
          Photos can't be loaded right now. OneDrive isn't answering; try again in a few minutes.
        </p>
      )}

      {(tabs || bar) && (
        <div className="pr-tools">
          {tabs}
          {/* No "click a frame" while the album still asks for its passcode: there is nothing to click yet. */}
          <span className="hint">{view === 'all' && locked ? '' : hint}</span>
          {bar}
        </div>
      )}

      {body}

      {view === 'mine' && open && !failed && data?.searched && keep && (keep.available || keep.on) && <KeepBox key={slug} slug={slug} keep={keep} onChange={(k) => setMine({ keep: k })} onStale={() => void mineQ.refetch()} toast={toast} />}

      <footer className="pr-foot">
        <Ticket title="One code. Every event." line="Come back with the same QR after the next event, or show it to a friend.">
          <ShareLink toast={toast} />
        </Ticket>
        <div className="fine">
          {me?.searched && (
            <p>
              <Icon name="lock" size={15} />
              <span>Your selfie was only used to find these photos. It is not kept.</span>
            </p>
          )}
          {downloadsOff && (
            <p>
              <span>Downloads are switched off for this event.</span>
            </p>
          )}
          {contact && (
            <p>
              <span>Need help? {contact}</span>
            </p>
          )}
          {view === 'mine' && canRemove && (
            <p>
              <button type="button" className="linkbtn" onClick={() => setRemoving(true)}>
                {REMOVE_LINK}
              </button>
            </p>
          )}
          {install && sureAll.length > 0 && (
            <p>
              <button type="button" className="btn sm ghost" onClick={install}>
                <Icon name="phone" size={16} /> Keep Event Photos on your phone
              </button>
            </p>
          )}
          <p>
            <Link className="linkbtn" to={`/e/${slug}/me${q}`} state={dialogState}>
              {me?.searched ? 'Delete my results for this event' : 'My data and privacy'}
            </Link>
          </p>
        </div>
      </footer>

      {openAt && list[openAt.index] && (
        <Viewer
          photos={list}
          index={openAt.index}
          onIndex={onIndex}
          onClose={onClose}
          canSave={openAt.list === 'all' ? !!lastPage?.download : !!data?.download}
          original={(p) => originalUrl(slug, p.id)}
          title={(i) => (openAt.list === 'all' ? `Frame ${two(i + 1)} of ${num(total ?? photos.length)}` : `Print ${i + 1} of ${list.length}`)}
          caption={(p) => [openAt.list === 'maybe' ? 'might be you' : mineIds.has(p.id) ? 'that’s you!' : '', p.by ? `added by ${p.by}` : ''].filter(Boolean).join(' · ') || null}
          picked={(p) => !!picked[p.id]}
          onPick={togglePick}
          actions={(p) => (
            <>
              {openAt.list !== 'all' && (
                <button type="button" className="linkbtn" onClick={() => void notMe(p)}>
                  Not me
                </button>
              )}
              <ReportButton slug={slug} photo={p} />
            </>
          )}
        />
      )}
      {dialog === 'add' && <AddDialog slug={slug} event={ev} me={me} loading={session.isPending} onClose={closeDialog} />}
      {dialog === 'me' && (
        <ForgetDialog
          slug={slug}
          event={ev}
          contact={contact}
          onClose={closeDialog}
          onRemove={
            canRemove
              ? () => {
                  closeDialog();
                  setRemoving(true);
                }
              : undefined
          }
          onDone={() => {
            keepShot(null);
            // Find says so: this screen goes away with the navigation.
            nav(findPage, { replace: true, state: { deleted: true } });
          }}
        />
      )}
      {removing && canRemove && (
        <RemovalDialog
          slug={slug}
          count={sureAll.length}
          onClose={() => setRemoving(false)}
          onSent={(r) => {
            setMine({ removal: r });
            setRemoving(false);
          }}
          onStale={() => void mineQ.refetch()}
        />
      )}
      {toastNode}
    </main>
  );
}

/** The old names of the prints screens. */
export const Mine = Prints;
export const Album = Prints;
export const AddPhotos = Prints;
export const MyData = Prints;

/** The quick reasons for a report; "Something else" asks for a few words instead. */
const REASONS = ['I’m in it and want it removed', 'It’s not appropriate'];
const OTHER = 'Something else';

/** Report this photo: one tap opens the reasons on a slip, a second sends one (or a few words of your own). */
function ReportButton({ slug, photo }: { slug: string; photo: Photo }) {
  const [step, setStep] = useState<'idle' | 'ask' | 'other' | 'sent' | 'failed'>('idle');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setStep('idle');
    setText('');
  }, [photo.id]);
  // The focus follows the slip: to the first reason when it opens, back to the link when it closes.
  const slip = useRef<HTMLDivElement>(null);
  const link = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    const on = step === 'ask' || step === 'other';
    if (on && !opened.current) slip.current?.querySelector<HTMLElement>('button')?.focus();
    if (!on && opened.current) link.current?.focus();
    opened.current = on;
  }, [step]);
  const send = async (reason: string) => {
    setBusy(true);
    try {
      await api(`/e/${slug}/report`, { json: { media_id: photo.id, reason: reason.slice(0, 300) } });
      setStep('sent');
    } catch {
      setStep('failed');
    } finally {
      setBusy(false);
    }
  };
  if (step === 'ask' || step === 'other') {
    return (
      <div ref={slip} className="slip vw-report" role="group" aria-labelledby="report-h">
        <p id="report-h" className="vw-report-h">
          Why are you reporting this {what(photo)}?
        </p>
        {step === 'other' ? (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              void send(text.trim() || OTHER);
            }}
          >
            <label htmlFor="report-why">
              A few words <small>(optional)</small>
            </label>
            <input id="report-why" value={text} maxLength={300} onChange={(ev) => setText(ev.target.value)} autoComplete="off" autoFocus />
            <div className="row">
              <button className="btn sm primary" disabled={busy}>
                {busy ? 'Sending…' : 'Send report'}
              </button>
              <button type="button" className="btn sm ink" disabled={busy} onClick={() => setStep('idle')}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="row">
            {REASONS.map((r) => (
              <button key={r} type="button" className="btn sm ink" disabled={busy} onClick={() => void send(r)}>
                {r}
              </button>
            ))}
            <button type="button" className="btn sm ink" disabled={busy} onClick={() => setStep('other')}>
              {OTHER}
            </button>
            <button type="button" className="linkbtn" disabled={busy} onClick={() => setStep('idle')}>
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }
  const label = { idle: 'Report this photo', sent: 'Reported to the organiser. Thank you.', failed: 'Could not send. Try again' }[step];
  return (
    <button ref={link} type="button" className="linkbtn" onClick={() => setStep('ask')} disabled={step === 'sent'}>
      {label}
    </button>
  );
}

// ---- the dialogs over Prints ----------------------------------------------------------------
/** A paper card over the dark veil: Escape closes it (unless `hold`), the focus stays inside and goes back after. */
function Dialog({ title, onClose, hold, children }: { title: string; onClose: () => void; hold?: boolean; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  useFocusTrap(card);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !hold) onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [hold, onClose]);
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && !hold && onClose()}>
      <div ref={card} className="modal-card pr-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1}>
        <h2 id="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const MAX_PICK = 30;
const MAX_PHOTO = 20 * 1024 * 1024;
const MAX_VIDEO = 200 * 1024 * 1024;
/** Answers that stop a whole run of uploads, not just the one file. */
const STOPS = ['limit_reached', 'uploads_off', 'offline', 'busy', 'no_device', 'disk_full'];
const NOT_SENT = 'Not sent.';
const THANKS = 'Thanks! An organiser will check them before they appear in the album.';

/** Hang your shots: a student adds the photos and videos they took. */
function AddDialog({ slug, event: e, me, loading, onClose }: { slug: string; event: EventInfo | null; me: Me | undefined; loading: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('ep.name') ?? '';
    } catch {
      return '';
    }
  });
  const [items, setItems] = useState<UploadItem[]>([]);
  const [run, setRun] = useState<{ added: number; waiting: number; copies: number; failed: number; stopped: string | null; finished: boolean; extra: number; done: number; total: number } | null>(null);
  const [over, setOver] = useState(false);
  const [left, setLeft] = useState<number | null>(me?.uploads_left ?? null);
  useEffect(() => setLeft(me?.uploads_left ?? null), [me?.uploads_left]);

  const send = async (picked: File[]) => {
    if (!picked.length) return;
    const files = picked.slice(0, MAX_PICK);
    try {
      localStorage.setItem('ep.name', name);
    } catch {
      /* fine */
    }
    const list: UploadItem[] = files.map((f, i) => ({ key: Date.now() + i, name: f.name, bytes: f.size, video: f.type.startsWith('video/'), state: 'waiting', sent: 0 }));
    const r = { added: 0, waiting: 0, copies: 0, failed: 0, stopped: null as string | null, finished: false, extra: picked.length - files.length, done: 0, total: files.length };
    const show = () => (setItems(list.map((x) => ({ ...x }))), setRun({ ...r }));
    show();
    for (let i = 0; i < files.length && !r.stopped; i++) {
      const f = files[i];
      const it = list[i];
      const video = it.video;
      if (!video && !f.type.startsWith('image/')) Object.assign(it, { state: 'failed', why: 'Only photos and videos can be added.' });
      else if (f.size > (video ? MAX_VIDEO : MAX_PHOTO)) Object.assign(it, { state: 'failed', why: `Larger than ${video ? '200' : '20'} MB.` });
      else {
        it.state = 'sending';
        show();
        try {
          const out = await uploadFile<{ result: 'added' | 'skipped'; review?: 'pending' | 'approved'; uploads_left?: number }>(`/e/${slug}/uploads`, f, {
            headers: name.trim() ? { 'x-uploader-name': encodeURIComponent(name.trim()) } : {},
            onProgress: (sent) => {
              it.sent = sent;
              show();
            },
          });
          if (typeof out.uploads_left === 'number') setLeft(out.uploads_left);
          if (out.result === 'added') {
            it.state = 'added';
            r.added++;
            if (out.review !== 'approved') r.waiting++;
          } else {
            it.state = 'copy';
            r.copies++;
          }
        } catch (err) {
          const x = err as ApiError;
          // These stop the whole run: the message shows once, above the list, and the rest are not sent.
          if (STOPS.includes(x.code ?? '')) r.stopped = x.message;
          Object.assign(it, { state: 'failed', why: r.stopped ? NOT_SENT : x.message });
        }
      }
      if (it.state === 'failed') r.failed++;
      r.done = i + 1;
      show();
    }
    for (const it of list) if (it.state === 'waiting') (Object.assign(it, { state: 'failed', why: NOT_SENT }), r.failed++);
    r.finished = true;
    r.done = r.total;
    show();
    // The event's photo counts may have changed.
    void qc.invalidateQueries(under(`/e/${slug}`));
    void qc.invalidateQueries(under('/events'));
  };

  const working = !!run && !run.finished;
  const closed = !loading && (!e || !e.options.upload);
  // The name field takes the focus once the event is known (the dialog may open before it is).
  useEffect(() => {
    if (!loading) document.getElementById('uploader')?.focus();
  }, [loading]);
  return (
    <Dialog title="Hang your shots" onClose={onClose} hold={working}>
      {loading ? (
        <p role="status">Loading…</p>
      ) : closed ? (
        <>
          <Note kind="warn">Adding photos is closed for this event.</Note>
          <div className="row">
            <button type="button" className="btn ink" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <div
          className={`pr-add ${over ? 'over' : ''}`}
          onDragOver={(ev) => {
            ev.preventDefault();
            if (!working) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(ev) => {
            ev.preventDefault();
            setOver(false);
            if (!working && ev.dataTransfer.files.length) void send(Array.from(ev.dataTransfer.files));
          }}
        >
          <p>
            Took photos or videos at <b>{e!.title}</b>? Add them to the roll. Copies already on it are skipped, and new ones join it after the organiser’s check.
          </p>
          <label htmlFor="uploader">
            Your name <small>(optional, shown under your photos)</small>
          </label>
          <input id="uploader" value={name} maxLength={40} onChange={(ev) => setName(ev.target.value)} placeholder="Your name" autoComplete="name" disabled={working} />
          {run && (
            <>
              <p className="prog" role="status">
                {run.finished ? 'Done' : `Hanging ${Math.min(run.done + 1, run.total)} of ${run.total}…`}
              </p>
              <div className="meter" aria-hidden>
                <i style={{ width: `${Math.round((100 * run.done) / Math.max(1, run.total))}%` }} />
              </div>
            </>
          )}
          {run?.finished && run.added > 0 && (
            <Note kind="ok" title={run.waiting > 0 ? THANKS : 'Thanks! They are in the album now.'}>
              {run.added} added{run.copies ? `, ${run.copies} already on the roll` : ''}
              {run.failed ? `, ${run.failed} could not be added` : ''}.
            </Note>
          )}
          {run?.finished && run.added === 0 && (
            <Note kind="warn" title="Nothing new was added">
              {run.copies ? `${run.copies} ${run.copies === 1 ? 'is' : 'are'} already on the roll. ` : ''}
              {run.failed ? 'See below for what went wrong.' : ''}
            </Note>
          )}
          {run?.stopped && <Note bad>{run.stopped}</Note>}
          {run && run.extra > 0 && <Note kind="warn">Only the first {MAX_PICK} were sent. Add the rest in another go.</Note>}
          {items.length > 0 && <UploadList items={items} />}
          <div className="row">
            <label className={`btn primary pr-choose ${working ? 'disabled' : ''}`}>
              <Icon name="plus" size={20} />
              <span>{run?.finished ? 'Add more photos or videos' : working ? 'Sending…' : 'Choose photos or videos'}</span>
              <input
                type="file"
                className="sr-only"
                accept="image/*,video/*"
                multiple
                disabled={working}
                onChange={(ev) => {
                  const files = Array.from(ev.target.files ?? []);
                  ev.target.value = '';
                  if (files.length) void send(files);
                }}
              />
            </label>
            <button type="button" className="btn ink" onClick={onClose} disabled={working}>
              {run?.finished ? 'Done' : 'Close'}
            </button>
          </div>
          <p className="small">
            Up to {MAX_PICK} at a time. Photos up to 20 MB, videos up to 200 MB.{left !== null ? ` You can add ${num(left)} more from this phone.` : ''}
          </p>
          <p className="small pr-shield">
            <Icon name="shield" size={16} />
            <span>Share only what you took or are allowed to share. An organiser checks every photo and video before it appears in the album.</span>
          </p>
        </div>
      )}
    </Dialog>
  );
}

// ---- Keep me updated and Remove me (features E and F) ---------------------------------------------
/** What the phone says when it cannot get a notification. */
const PUSH_LINE: Record<Exclude<PushBlock, null>, string> = {
  ios_not_installed: "On iPhone, add this page to your Home Screen to get a notification. Otherwise you'll see new photos here when you come back.",
  denied: "Notifications are off for this site. You'll see new photos here when you come back.",
  unsupported: "You'll see new photos here when you come back.",
};

/**
 * Tell me when new photos of me arrive: a separate opt-in with its own consent line. Only when it is ticked does the
 * server keep a code made from the selfie still in this tab's memory; the notification permission is asked after.
 */
function KeepBox({ slug, keep, onChange, onStale, toast }: { slug: string; keep: KeepState; onChange: (k: KeepState) => void; onStale: () => void; toast: (t: string) => void }) {
  const [params] = useSearchParams();
  const q = campusQuery(params.get('campus'));
  const [busy, setBusy] = useState(false);
  const [needShot, setNeedShot] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [block, setBlock] = useState<PushBlock>(() => pushBlock());
  const [asking, setAsking] = useState(false);
  const [noPush, setNoPush] = useState(false);
  const boxRef = useRef<HTMLInputElement>(null);

  const turnOn = async () => {
    if (busy) return;
    const shot = lastShot && lastShot.slug === slug ? lastShot.blob : undefined;
    setErr(null);
    if (!shot) return setNeedShot(true);
    setBusy(true);
    try {
      const out = await api<{ keep: KeepState }>(`/e/${slug}/keep`, { body: shot, headers: { 'x-keep-consent': KEEP_CONSENT, 'content-type': 'image/jpeg' } });
      setNeedShot(false);
      setBlock(pushBlock());
      onChange(out.keep);
    } catch (e) {
      const x = e as ApiError;
      setErr(x.message || 'Something went wrong. Try again.');
      // The selfie in memory was not good enough: a new one is needed.
      if (x.code === 'no_face' || x.code === 'no_selfie' || x.code === 'unreadable') setNeedShot(true);
      if (['face_ended', 'keep_off', 'not_open', 'face_off', 'not_searched'].includes(x.code)) onStale();
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const out = await api<{ keep: KeepState }>(`/e/${slug}/keep`, { method: 'DELETE' });
      void unsubscribePush(slug);
      setNoPush(false);
      onChange(out.keep);
      toast('Turned off. Your face code is deleted.');
      // The Stop button goes away: keep the keyboard on the box.
      boxRef.current?.focus();
    } catch (e) {
      setErr((e as Error).message || 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const allow = async () => {
    setAsking(true);
    const ok = await subscribePush(slug);
    setAsking(false);
    if (ok) return onChange({ ...keep, push: true });
    const now = pushBlock();
    setBlock(now);
    // Dismissed, or the phone could not subscribe: the photos still show here.
    if (!now) setNoPush(true);
  };

  const pushPart = keep.push ? null : block ? (
    <p className="keep-say">{PUSH_LINE[block]}</p>
  ) : noPush ? (
    <p className="keep-say">{PUSH_LINE.unsupported}</p>
  ) : (
    <button type="button" className="btn sm primary" onClick={() => void allow()} disabled={asking || busy}>
      <Icon name="bell" size={18} /> {asking ? 'Asking…' : 'Allow notifications'}
    </button>
  );

  return (
    <section className="pr-keep" aria-label="Keep me updated">
      <div className="slip keep-slip">
        <label className="keep-box">
          <input
            ref={boxRef}
            type="checkbox"
            checked={keep.on}
            // Not disabled while busy (a disabled box loses the keyboard focus); taps are ignored instead.
            disabled={!keep.on && !keep.available}
            aria-disabled={busy || undefined}
            aria-describedby="keep-why"
            onChange={(ev) => void (ev.target.checked ? turnOn() : turnOff())}
          />
          <span className="keep-tick" aria-hidden>
            <Icon name="check" size={16} />
          </span>
          <span className="keep-t">Tell me when new photos of me arrive</span>
        </label>
        <p id="keep-why" className="keep-why">
          {KEEP_LINE}
        </p>
        <div role="status" className="keep-state">
          {busy && <p className="keep-say">{keep.on ? 'Turning it off…' : 'Turning it on…'}</p>}
          {!busy && !keep.on && needShot && (
            <p className="keep-say">
              <Link to={`/e/${slug}/find${q}`}>Take a new selfie</Link> to turn this on.
            </p>
          )}
          {keep.on && <p className="keep-say">On. We'll tell you when new photos of you arrive.</p>}
        </div>
        {err && (
          <p className="keep-err" role="alert">
            {err}
          </p>
        )}
        {keep.on && (
          <div className="keep-acts">
            {pushPart}
            <button type="button" className="btn sm ink" onClick={() => void turnOff()} disabled={busy}>
              Stop telling me
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** Ask to remove me from this event's photos: the organisers get a request listing the photos found of you. */
function RemovalDialog({ slug, count: n, onClose, onSent, onStale }: { slug: string; count: number; onClose: () => void; onSent: (r: RemovalState) => void; onStale: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const text = note.trim().slice(0, 300);
      const out = await api<{ removal: RemovalState }>(`/e/${slug}/removal`, { json: text ? { note: text } : {} });
      onSent(out.removal);
    } catch (e) {
      const x = e as ApiError;
      setErr(x.message || 'Something went wrong. Try again.');
      setBusy(false);
      if (x.code === 'removal_open' || x.code === 'nothing_to_remove' || x.code === 'not_open') onStale();
    }
  };
  return (
    <Dialog title="Remove me from these photos?" onClose={onClose} hold={busy}>
      <p>
        We'll ask the organisers to take the {num(n)} {plural(n, 'photo', 'photos')} we found of you out of the album. They check each request first.
      </p>
      <form className="pr-remove" onSubmit={send}>
        <label htmlFor="removal-note">
          Anything they should know? <small>(optional)</small>
        </label>
        <textarea id="removal-note" value={note} maxLength={300} rows={3} onChange={(ev) => setNote(ev.target.value)} disabled={busy} />
        {err && <Note bad>{err}</Note>}
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send request'}
          </button>
          <button type="button" className="btn ink" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Delete my results: what the selfie found in this event goes from the server. */
function ForgetDialog({ slug, event: e, contact, onClose, onDone, onRemove }: { slug: string; event: EventInfo | null; contact: string | null; onClose: () => void; onDone: () => void; onRemove?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const erase = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api(`/e/${slug}/me`, { method: 'DELETE' });
      qc.removeQueries({ queryKey: apiKey(`/e/${slug}/mine`) });
      void qc.invalidateQueries();
      onDone();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <Dialog title="Delete my results?" onClose={onClose} hold={busy}>
      <p>This removes what your selfie found in {e?.title ?? 'this event'} from the server. The photos themselves stay in the album.</p>
      {failed && <Note bad>That did not work. Check your connection and try again.</Note>}
      <div className="row">
        <button type="button" className="btn danger solid" onClick={erase} disabled={busy}>
          <Icon name="trash" size={18} /> {busy ? 'Deleting…' : 'Delete'}
        </button>
        <button type="button" className="btn ink" onClick={onClose} disabled={busy} data-autofocus>
          Keep them
        </button>
      </div>
      <details className="more">
        <summary>What this app keeps about you</summary>
        <div className="in small">
          <p>
            <b>What is kept.</b> The list of photos your selfie matched in this event, tied to this phone. No name, no login, and no copy of your selfie: it is deleted right after the search. Photos you add are kept, with your name only if you typed one.
          </p>
          <p>
            <b>For how long.</b> Until you delete it here, or until the organiser closes this album for good. Then the face data of the event and everyone’s results are deleted.
          </p>
          <p>
            <b>Keep me updated:</b> only if you tick it, we keep a code made from your face for this event, until you turn it off, delete your results, or the event's face search ends.
          </p>
          <p>
            <b>Take a photo down.</b> Open the photo and tap Report this photo. An organiser looks at every report.
            {onRemove && (
              <>
                {' '}
                <button type="button" className="linkbtn" onClick={onRemove}>
                  {REMOVE_LINK}
                </button>
              </>
            )}
          </p>
          <p>
            <b>Who to ask.</b> {contact ? `For any question about your data or a photo: ${contact}.` : 'For any question about your data or a photo, ask the event organiser or the college help desk.'}
          </p>
        </div>
      </details>
    </Dialog>
  );
}
