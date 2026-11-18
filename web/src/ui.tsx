import { useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ICON_PATHS, type IconName } from './icons';
import { clock, isVideo, niceDate, piped, retried, size, type EventInfo, type Photo } from './lib/api';

/** A line icon from the UI kit, in the text colour. */
export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}

/** The page title row: a back button, the title, and whatever goes on the right. */
export function Head({ back, title, children }: { back?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="head">
      {back && (
        <Link className="iconbtn" to={back} aria-label="Back">
          <Icon name="back" />
        </Link>
      )}
      <h1>{title}</h1>
      {children}
    </div>
  );
}

/** Status colours of the kit: blue new, green active, orange waiting, gray done, red a problem. */
const STATUS: Record<string, [string, string]> = {
  draft: ['blue', 'Coming soon'],
  live: ['green', 'Open'],
  closed: ['gray', 'Closed'],
  archived: ['gray', 'Archived'],
  failed: ['red', 'Failed'],
  skipped: ['orange', 'Skipped'],
  waiting: ['blue', 'Waiting'],
  processing: ['blue', 'Processing'],
  done: ['green', 'Done'],
  hidden: ['gray', 'Hidden'],
  review: ['orange', 'Waiting for approval'],
};
export const statusColour = (state: string) => STATUS[state]?.[0] ?? 'gray';

/** A state as a rubber stamp: condensed capitals in a box of its colour, a hair askew. */
export function Stamp({ state }: { state: string }) {
  const [colour, label] = STATUS[state] ?? ['gray', state];
  return <span className={`pill stamp ${colour}`}>{label}</span>;
}

type NoteKind = 'info' | 'ok' | 'warn' | 'bad';
const NOTE_ICON: Record<NoteKind, IconName> = { info: 'alert', ok: 'check', warn: 'clock', bad: 'alert' };

/** A message on a paper slip: info, ok, warn, or bad (written in dark red). */
export function Note({ children, bad, kind, title }: { children?: ReactNode; bad?: boolean; kind?: NoteKind; title?: string }) {
  const k: NoteKind = bad ? 'bad' : kind ?? 'info';
  return (
    <div className={`notice ${k === 'warn' ? '' : k}`} role={k === 'bad' ? 'alert' : 'status'}>
      <Icon name={NOTE_ICON[k]} size={20} />
      <div>
        {title && <b>{title}</b>}
        {children}
      </div>
    </div>
  );
}

/** The "nothing here" state: an empty frame, a title in condensed capitals, a line under it. */
export function Empty({ icon = 'image', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="chip navy">
        <Icon name={icon} size={28} />
      </span>
      <p>
        <b>{title}</b>
        {children && (
          <>
            <br />
            {children}
          </>
        )}
      </p>
    </div>
  );
}

/** What Load needs from a query: TanStack Query results fit as they are. */
export interface Loadable {
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => unknown;
}

/** Loading, error with retry, or the content. Every screen needs these states. */
export function Load({ query, state, retry, children }: { query?: Loadable; state?: { loading: boolean; error: string | null }; retry?: () => void; children: ReactNode }) {
  // Trying again after an error shows Loading… again, as the first try did.
  const s = query ? { loading: query.isPending || (query.isError && query.isFetching), error: query.isError && !query.isFetching ? query.error?.message || 'Something went wrong.' : null } : state ?? { loading: false, error: null };
  const again = retry ?? (query ? () => void query.refetch() : undefined);
  if (s.loading)
    return (
      <div className="empty" role="status">
        <div className="spin dark" aria-hidden />
        Loading…
      </div>
    );
  if (s.error)
    return (
      <div className="py-4 grid gap-3 justify-items-start">
        <Note bad>{s.error}</Note>
        {again && (
          <button type="button" className="btn" onClick={again}>
            <Icon name="refresh" size={18} /> Try again
          </button>
        )}
      </div>
    );
  return <>{children}</>;
}

export const eventWhen = (e: { starts_on: string | null; venue: string | null }) => [niceDate(e.starts_on), e.venue].filter(Boolean).join(' · ');

/** A grease-pencil circle, drawn by hand round a frame on the contact sheet: this photo is yours. */
export function PencilCircle({ draw, delay = 0 }: { draw?: boolean; delay?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  // The line keeps its thickness whatever the frame's size, so the stroke's length is measured on screen;
  // without this the circle stops short on large frames.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !draw) return;
    const { width, height } = el.getBoundingClientRect();
    const a = width * 0.47;
    const b = height * 0.47;
    const round = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    el.style.setProperty('--len', `${Math.ceil(round * 1.1)}px`);
  }, [draw]);
  return (
    <svg ref={ref} className={`pencil ${draw ? 'draw' : ''}`} viewBox="0 0 100 100" preserveAspectRatio="none" style={{ ['--delay' as any]: `${delay}ms` }} aria-hidden>
      <path d="M52 4 C 80 3, 97 20, 96 49 C 95 80, 76 97, 48 96 C 20 95, 3 78, 4 49 C 5 22, 22 6, 58 5" />
    </svg>
  );
}

// ---- The darkroom: the red-lit room, film as the structure, paper for what you read -----

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** A date as printed along a film's edge: "2026-11-14" is "14 NOV 26"; no date is "DATE TBC". */
export function edgeDate(day: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? '');
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(-2)}` : 'DATE TBC';
}

/** A small steady tilt (in degrees, up to ±max) for a print, from its id: the line looks hand-hung and stays the same on every visit. */
export function tilt(id: string, max = 1.9): number {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  let t = (h % 2000) / 1000 - 1;
  if (Math.abs(t) < 0.3) t += t < 0 ? -0.3 : 0.3;
  return Number((t * max).toFixed(2));
}

/** Edge print: amber condensed capitals with the small triangle, as printed along a film's edge. */
export function EdgePrint({ children, className = '', as: Tag = 'span' }: { children: ReactNode; className?: string; as?: 'span' | 'p' | 'h1' | 'h2' }) {
  return <Tag className={`edge-print ${className}`}>{children}</Tag>;
}

/** The safelight: a red bulb with its glow. Decoration only. */
export function Lamp() {
  return (
    <span className="lamp" aria-hidden>
      <i />
    </span>
  );
}

/** A row of film sprocket holes: the film accent along an edge. */
export function Sprockets({ className = '' }: { className?: string }) {
  return <div className={`sprockets ${className}`} aria-hidden />;
}

/** The aerial photo of the green hilltop campus. */
export function CampusPhoto({ className = 'bg' }: { className?: string }) {
  return <img className={className} src="/brand/campus.webp" srcSet="/brand/campus-800.webp 800w, /brand/campus.webp 1600w" sizes="100vw" alt="" decoding="async" />;
}

/** The university's logo on a paper plate, so it reads in the darkroom. */
export function LogoPlate({ small }: { small?: boolean }) {
  return (
    <span className={`logo-plate ${small ? 'sm' : ''}`}>
      <img src="/logo.png" alt="St. Mary's Rehabilitation University" />
    </span>
  );
}

/**
 * The top of the public pages: the red-lit room with the safelight's glow, the logo and the lamp, a title and one
 * line. No photo is laid under the words (a photo is never tinted or veiled); `image` and `state` are kept for the
 * screens that pass them.
 */
export function CampusHero({ title, line, top, children, home, narrow, eyebrow }: { title: ReactNode; line?: ReactNode; image?: string | null; top?: ReactNode; children?: ReactNode; home?: boolean; narrow?: boolean; eyebrow?: ReactNode; state?: string }) {
  return (
    <header className={`campus-hero ${home ? 'home' : ''} ${narrow ? 'narrow' : ''}`}>
      <div className="glow" aria-hidden />
      <div className="in">
        <div className="hero-top">
          {top ?? <LogoPlate />}
          <Lamp />
        </div>
        <div>
          {eyebrow && <p className="eyebrow mt-6 mb-0">{eyebrow}</p>}
          <h1>{title}</h1>
          {line && <p className="line">{line}</p>}
          {children}
        </div>
      </div>
    </header>
  );
}

/** The four L-shaped corners of a viewfinder, over whatever box it is put in (the box needs position: relative). */
export function Corners({ amber, tight }: { amber?: boolean; tight?: boolean }) {
  return <span className={`vf ${amber ? 'amber' : ''} ${tight ? 'tight' : ''}`} aria-hidden />;
}

/** The camera's data strip: the exposure on the left, a red recording dot and the state on the right. */
export function Hud({ state = 'Live', exposure = 'ƒ/1.8 · 1/250 · ISO 400', className = '', over }: { state?: string; exposure?: string; className?: string; over?: 'top' | 'bottom' }) {
  return (
    <div className={`hud ${over ? `over at-${over}` : ''} ${className}`} aria-hidden>
      <span className="exp">{exposure}</span>
      <b className="rec">{state}</b>
    </div>
  );
}

/** The white flash of a shot, over the whole screen. Mounted once (Darkroom); flash() fires it. */
export function flash(): void {
  const el = document.getElementById('flash');
  if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  el.classList.remove('pop');
  void el.offsetWidth; // restart the animation
  el.classList.add('pop');
}

/** The film grain behind every page, and the flash. They never take a tap. */
export function Darkroom() {
  return (
    <>
      <div className="grain" aria-hidden />
      <div className="flash" id="flash" aria-hidden />
    </>
  );
}

/**
 * The red shutter: a ring, a red disc with its glow, and the word under it (`small`, e.g. "Take selfie").
 * `label` is what a screen reader says. (`icon` is kept for older callers; the disc carries no icon.)
 */
export function Shutter({ onClick, disabled, busy, label, small = 'Press' }: { onClick: () => void; disabled?: boolean; busy?: boolean; label: string; icon?: IconName; small?: string }) {
  return (
    <button type="button" className={`shutter ${busy ? 'busy' : ''}`} onClick={onClick} disabled={disabled} aria-label={label}>
      <i aria-hidden />
      <span aria-hidden>{small}</span>
    </button>
  );
}

/** A Polaroid: a print with tape on top and a handwritten caption under it. */
export function Polaroid({ children, caption, left, className = '' }: { children: ReactNode; caption?: ReactNode; left?: boolean; className?: string }) {
  return (
    <figure className={`polaroid ${left ? 'left' : ''} ${className} m-0`}>
      <span className="tape" aria-hidden />
      <div className="photo">{children}</div>
      {caption && <figcaption className="cap">{caption}</figcaption>}
    </figure>
  );
}

/** A frame number as printed along the film edge: 1 → "01A". */
export const frameNo = (i: number) => `${String(i + 1).padStart(2, '0')}A`;

/** The bar on top of an inner page: the back arrow, the title as edge print (and a line under it), whatever goes on the right. */
export function TopBar({ back, title, sub, children }: { back?: string; title: string; sub?: string; children?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="in">
        {back && (
          <Link className="back" to={back} aria-label="Back">
            <Icon name="arrowback" size={24} />
          </Link>
        )}
        <div className="t">
          <h1>
            <span>{title}</span>
          </h1>
          {sub && <p>{sub}</p>}
        </div>
        {children}
      </div>
    </header>
  );
}

/** Waits before an album image is asked for again (its copy is being made in OneDrive, or OneDrive is slow). */
export const IMG_RETRY_MS = [5000, 20000, 60000];

/**
 * An album image (its copy lives in OneDrive). When it does not load (being prepared, OneDrive busy for a moment) it
 * is asked for again after 5 s, 20 s and 60 s, with a quiet "being prepared" tile in between (is-preparing), and
 * only then gives up.
 */
export function AlbumImg({ src, className, onLoad, onError, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [tries, setTries] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setTries(0);
    setWaiting(false);
  }, [src]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <img
      {...rest}
      src={tries ? retried(src, tries) : src}
      className={[className, waiting ? 'is-preparing' : ''].filter(Boolean).join(' ') || undefined}
      data-preparing={waiting ? 'true' : undefined}
      onLoad={(e) => {
        setWaiting(false);
        onLoad?.(e);
      }}
      onError={(e) => {
        if (tries >= IMG_RETRY_MS.length) {
          setWaiting(false);
          onError?.(e);
          return;
        }
        setWaiting(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setTries((t) => t + 1), IMG_RETRY_MS[tries]);
      }}
    />
  );
}

/** A peek at the album: a few of its frames on a short strip of film. */
export function FilmPeek({ frames, to, label }: { frames: string[]; to: string; label: string }) {
  return (
    <Link className="peek" to={to} aria-label={label}>
      <Sprockets />
      <div className="frames">
        {frames.slice(0, 6).map((src, i) => (
          <AlbumImg key={i} src={src} alt="" loading="lazy" />
        ))}
        {/* the rest of the roll: unexposed frames */}
        {Array.from({ length: Math.max(0, 4 - frames.length) }, (_, i) => (
          <span key={`b${i}`} className="blank" />
        ))}
      </div>
      <Sprockets />
    </Link>
  );
}

/** Filter buttons in a row (campuses, photo filters): one is pressed at a time. */
export function Chips<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: { key: T; label: string; count?: number }[]; onChange: (key: T) => void }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.key} type="button" className="chipbtn" aria-pressed={value === it.key} onClick={() => onChange(it.key)}>
          {it.label}
          {it.count !== undefined && it.count > 0 && <span className="n">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Plain tabs: one panel shows at a time. */
export function Tabs<T extends string>({ label, value, items, onChange, small }: { label: string; value: T; items: { key: T; label: string; hot?: boolean }[]; onChange: (key: T) => void; small?: boolean }) {
  // On a phone the row scrolls sideways: the picked tab is brought into view, so it is always clear which one is open.
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const r = row.current;
    const on = r?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!r || !on || r.scrollWidth <= r.clientWidth) return;
    const left = on.getBoundingClientRect().left - r.getBoundingClientRect().left + r.scrollLeft;
    if (left < r.scrollLeft || left + on.offsetWidth > r.scrollLeft + r.clientWidth) r.scrollLeft = Math.max(0, left - 24);
  }, [value]);
  return (
    <div ref={row} className={`ptabs ${small ? 'small' : ''}`} role="tablist" aria-label={label}>
      {items.map((it) => (
        <button key={it.key} type="button" role="tab" aria-selected={value === it.key} className={`ptab ${it.hot ? 'hot' : ''}`} onClick={() => onChange(it.key)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** The one main action of a screen: the red plate with a shutter ring. */
export function BigAction({ to, onClick, icon = 'camera', title, sub, disabled, type = 'button' }: { to?: string; onClick?: () => void; icon?: IconName; title: string; sub?: string; disabled?: boolean; type?: 'button' | 'submit' }) {
  const inner = (
    <>
      <span className="ic" aria-hidden>
        <Icon name={icon} size={28} />
      </span>
      <span className="tx">
        <b>{title}</b>
        {sub && <span className="sub">{sub}</span>}
      </span>
      <Icon name="chev" size={22} className="go" />
    </>
  );
  return to && !disabled ? (
    <Link className="bigaction" to={to}>
      {inner}
    </Link>
  ) : (
    <button type={type} className="bigaction" onClick={onClick} disabled={disabled}>
      {inner}
    </button>
  );
}

/** An on/off switch with its label and a line of explanation. */
export function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden>
        <span className="knob" />
      </span>
      <span className="min-w-0">
        <b>{label}</b>
        {hint && <span className="muted small block">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * One event as a frame of film: sprockets along both edges, the date as edge print, the cover in its true colours
 * (a red count of your photos on it), then the name in capitals, the date and the campus. `index` is kept for callers.
 */
export function EventCard({ event }: { event: EventInfo; index?: number }) {
  const cover = event.cover ?? event.strip[0] ?? null;
  const soon = event.state === 'draft';
  const edge = event.state === 'live' ? 'Now showing' : soon ? 'Coming soon' : event.state === 'closed' ? 'Archive' : '';
  return (
    <Link className="evcard" to={`/e/${event.slug}`}>
      <div className="cover">
        {cover ? <AlbumImg src={cover} alt="" loading="lazy" /> : <span className="none">{soon ? 'Opens soon' : 'No photos yet'}</span>}
        <span className="count">{soon ? 'Photos soon' : `${event.photos} ${event.photos === 1 ? 'photo' : 'photos'}`}</span>
        {event.mine > 0 && (
          <span className="mine">
            <Icon name="check" size={14} /> {event.mine === 1 ? '1 of you' : `${event.mine} of you`}
          </span>
        )}
        {soon && cover && (
          <span className="soonmark" aria-hidden>
            Soon
          </span>
        )}
      </div>
      <div className="frame-no" aria-hidden>
        <span>{edgeDate(event.starts_on)}</span>
        <span>{edge}</span>
      </div>
      <div className="body">
        <h3>{event.title}</h3>
        <div className="meta">
          {event.starts_on && (
            <span className="inline-flex items-center gap-1">
              <Icon name="calendar" size={15} /> {niceDate(event.starts_on)}
            </span>
          )}
          {event.campus && (
            <span className="inline-flex items-center gap-1">
              <Icon name="pin" size={15} /> {event.campus.name}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

/** A video's small badge: a play mark and its length. */
export function VideoBadge({ ms }: { ms?: number | null }) {
  return (
    <span className="vbadge">
      <Icon name="play" size={11} />
      {clock(ms) || 'Video'}
    </span>
  );
}

/**
 * Photos and videos as a grid of square tiles. circled = the ones that are yours (a grease-pencil circle);
 * maybe = the less certain ones (an orange ?). Videos carry a play badge with their length.
 */
export function MediaGrid({ items, onOpen, circled, maybe, draw, roomy, numbered = true }: { items: Photo[]; onOpen: (index: number) => void; circled?: Set<string> | 'all'; maybe?: boolean; draw?: boolean; roomy?: boolean; numbered?: boolean }) {
  return (
    <ul className={`mgrid ${roomy && items.length <= 4 ? 'roomy' : ''}`}>
      {items.map((p, i) => {
        const mine = circled === 'all' || !!circled?.has(p.id);
        const video = isVideo(p);
        return (
          <li key={p.id}>
            <button type="button" className="mtile" onClick={() => onOpen(i)} aria-label={`Open ${video ? 'video' : 'photo'} ${i + 1}${mine ? ', one of yours' : ''}${video && p.duration_ms ? `, ${clock(p.duration_ms)} long` : ''}`}>
              <AlbumImg src={roomy && items.length <= 4 ? p.web : p.thumb} alt="" loading="lazy" />
              {numbered && <span className="fno" aria-hidden>{frameNo(i)}</span>}
              {video && <VideoBadge ms={p.duration_ms} />}
              {mine && <PencilCircle draw={draw} delay={Math.min(i, 14) * 90} />}
              {maybe && <span className="maybe-mark">?</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Where files are dropped or chosen: the dashed "Hang your shots" slot, which is also a file button. */
export function DropZone({ title, hint, accept, multiple = true, disabled, onFiles, icon = 'upload', compact }: { title: string; hint?: string; accept: string; multiple?: boolean; disabled?: boolean; onFiles: (files: File[]) => void; icon?: IconName; compact?: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <label
      className={`drop ${over ? 'over' : ''} ${disabled ? 'disabled' : ''} ${compact ? 'compact' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled && e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <span className="st">
        <Icon name={icon} size={compact ? 20 : 22} />
        <b>{title}</b>
      </span>
      {hint && <span className="sd">{hint}</span>}
      <input
        type="file"
        className="sr-only"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

/** One file of an upload, as the upload list shows it. */
export interface UploadItem {
  key: number;
  name: string;
  bytes: number;
  video: boolean;
  state: 'waiting' | 'sending' | 'added' | 'copy' | 'failed';
  sent: number;
  why?: string;
}

const UP_STATE: Record<UploadItem['state'], [string, string]> = {
  waiting: ['gray', 'Waiting'],
  sending: ['blue', 'Sending'],
  added: ['green', 'Added'],
  copy: ['orange', 'Already there'],
  failed: ['red', 'Not added'],
};

/** Every file of an upload on a paper list, each with its stamp and a red meter while it is sent. */
export function UploadList({ items }: { items: UploadItem[] }) {
  return (
    <ul className="uplist" aria-label="Files being added">
      {items.map((f) => {
        const [colour, label] = UP_STATE[f.state];
        const pct = f.bytes ? Math.round((Math.min(f.sent, f.bytes) / f.bytes) * 100) : 0;
        return (
          <li key={f.key}>
            <span className={`chip ${colour}`} aria-hidden>
              <Icon name={f.state === 'added' ? 'check' : f.state === 'failed' ? 'alert' : f.video ? 'video' : 'image'} size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="name">{f.name}</span>
                <span className="muted small flex-none">{size(f.bytes)}</span>
              </div>
              {f.state === 'sending' ? (
                <div className="meter" role="progressbar" aria-label={`Sending ${f.name}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: `${pct}%` }} />
                </div>
              ) : f.why ? (
                <span className="why">{f.why}</span>
              ) : null}
            </div>
            <span className={`pill stamp ${colour}`}>{f.state === 'sending' ? `${pct}%` : label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** A person's face: a round print with a paper ring, or their initials when there is no photo yet. */
export function Face({ src, name, size: px = 56 }: { src: string | null | undefined; name: string; size?: number }) {
  // Initials of the first and last name, without titles: "Prof. S. Devi" is SD.
  const words = name.split(/\s+/).filter((w) => w && !/^(dr|prof|mr|mrs|ms|sri|shri|smt|rev|fr|sr)\.?$/i.test(w));
  const initials = [words[0], words.length > 1 ? words.at(-1) : undefined]
    .filter(Boolean)
    .map((w) => w![0]!.toUpperCase())
    .join('');
  return src ? <img className="face" src={src} alt="" style={{ width: px, height: px }} /> : <span className="face none" style={{ width: px, height: px, fontSize: px / 2.8 }} aria-hidden>{initials || '?'}</span>;
}

/** A file name with the extension of what was actually fetched (the album's copies are WebP, a video's are MP4). */
const EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};
const named = (name: string, type: string) => {
  const ext = EXT[type.split(';')[0].trim().toLowerCase()];
  return ext ? name.replace(/\.[^.]+$/, '') + `.${ext}` : name;
};

/** The file name the server gave (Content-Disposition), when it gave one. */
function serverName(res: Response): string | null {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* the plain name below */
    }
  }
  return /filename\s*=\s*"([^"]+)"/i.exec(cd)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(cd)?.[1]?.trim() ?? null;
}

/** Hands a file that is already here to the browser's own download. */
function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const asFile = (blob: Blob, name: string) => new File([blob], name, { type: blob.type || (/\.(mp4|mov|webm|mkv)$/i.test(name) ? 'video/mp4' : 'image/jpeg') });
const cancelled = (err: unknown) => (err as { name?: string } | null)?.name === 'AbortError';

/**
 * The photo (or video) the viewer shows, fetched as a file; throws when it cannot be. Through the app (pipe=1), not
 * the redirect to OneDrive: a fetch() that follows a redirect to another site needs that site to allow it.
 */
async function fetchFile(url: string, name: string): Promise<File> {
  const res = await fetch(piped(url));
  if (!res.ok) throw new Error('gone');
  const blob = await res.blob();
  return asFile(blob, named(name, blob.type));
}

export async function savePhoto(url: string, name: string): Promise<void> {
  const file = await fetchFile(url, name);
  saveBlob(file, file.name);
}

/**
 * The phone's share sheet with the photo (so it can go to the gallery or a chat), fetched once; saved instead where
 * this phone cannot share files. Closing the share sheet is fine; throws when the photo could not be shared or saved.
 */
export async function sharePhoto(url: string, name: string): Promise<void> {
  const file = await fetchFile(url, name);
  if (!navigator.canShare?.({ files: [file] })) return saveBlob(file, file.name);
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (!cancelled(err)) throw err;
  }
}

type Fetched = { file: File } | { link: string } | { message: string };

/**
 * The original, fetched as a file. A server that answers with a OneDrive link: that file is fetched too, or, when the
 * browser may not read it, the link is given back to open on its own. Never leaves the page.
 */
async function loadOriginal(url: string, name: string): Promise<Fetched> {
  try {
    let res = await fetch(url, { redirect: 'manual', credentials: 'same-origin' });
    if (res.type === 'opaqueredirect') {
      try {
        res = await fetch(url, { credentials: 'same-origin' });
      } catch {
        return { link: url };
      }
    }
    if (res.ok) {
      // The server sent the file itself: kept under the name it gave (its own extension: a full-quality JPEG of an
      // iPhone photo, a PNG original, a .mov video), or this name with the extension of what came.
      const blob = await res.blob();
      return { file: asFile(blob, serverName(res) ?? named(name, blob.type)) };
    }
    const data = await res.json().catch(() => null);
    return { message: data?.message && data.error !== 'server_error' ? data.message : 'The original could not be fetched right now. Try again in a moment.' };
  } catch {
    return { message: 'No connection. Check your internet and try again.' };
  }
}

/**
 * The original can be large: fetched first, so a problem shows as a message instead of a broken file. Gives back
 * null when the download went ahead, or the message to show.
 */
export async function getOriginal(url: string, name: string): Promise<string | null> {
  const got = await loadOriginal(url, name);
  if ('message' in got) return got.message;
  if ('link' in got) window.open(got.link, '_blank', 'noopener');
  else saveBlob(got.file, got.file.name);
  return null;
}

/** How many files go into one share sheet. */
const SHARE_AT_ONCE = 10;
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Several originals at once. On a phone that can share files they go to its share sheet together (Save to Photos),
 * a few at a time; otherwise, or when sharing fails, they are saved one by one with a short gap. The page never
 * navigates away in between. `cancelled` when the student closed the share sheet; `trouble` is the last problem.
 */
export async function saveOriginals(items: { url: string; name: string }[], onStep: (done: number) => void): Promise<{ trouble: string | null; cancelled: boolean }> {
  const touch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  let trouble: string | null = null;
  let done = 0;
  let share = touch && typeof navigator !== 'undefined' && !!navigator.canShare;
  // Saved one by one: each as soon as it is here (a video original can be large), a short gap between two.
  let saved = 0;
  const save = async (f: File) => {
    if (saved++) await pause(350);
    saveBlob(f, f.name);
  };
  for (let i = 0; i < items.length; i += SHARE_AT_ONCE) {
    const files: File[] = [];
    for (const it of items.slice(i, i + SHARE_AT_ONCE)) {
      onStep(done);
      const got = await loadOriginal(it.url, it.name);
      done++;
      if ('message' in got) trouble = got.message;
      else if ('link' in got) window.open(got.link, '_blank', 'noopener');
      else if (share) files.push(got.file);
      else await save(got.file);
    }
    if (!files.length) continue;
    if (navigator.canShare({ files })) {
      try {
        await navigator.share({ files });
        continue;
      } catch (err) {
        if (cancelled(err)) return { trouble: null, cancelled: true };
      }
    }
    share = false; // saved one by one from here on
    for (const f of files) await save(f);
  }
  return { trouble, cancelled: false };
}

async function fetchOriginal(e: React.MouseEvent, url: string, name: string, say: (s: string | null) => void) {
  e.preventDefault();
  say('busy');
  say(await getOriginal(url, name));
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * For a dialog: the focus moves in (to the element marked data-autofocus, else the first field or button), Tab stays
 * inside, and when the dialog goes the focus goes back to what had it before.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const first = box?.querySelector<HTMLElement>('[data-autofocus]') ?? box?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box)?.focus?.();
    const key = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key !== 'Tab' || !el) return;
      const all = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!all.length) return;
      const a = all[0];
      const z = all[all.length - 1];
      if (e.shiftKey && (document.activeElement === a || !el.contains(document.activeElement))) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && (document.activeElement === z || !el.contains(document.activeElement))) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (from && document.contains(from)) from.focus?.();
    };
  }, [ref]);
}

/** Where a video from your results starts playing: a second before your face is seen, so you see yourself come in. */
const startOf = (ms: number) => Math.max(0, ms / 1000 - 1);

/**
 * One photo or video, full screen, as a print in the dark: the picture on paper (never tinted), prev/next on a laptop,
 * swipe and pinch or double-tap zoom on a phone, a handwritten tag under it, Download (full quality) and Select, then
 * the screen's own actions (Not me, Report) and Share.
 */
export function Viewer({
  photos,
  index,
  onIndex,
  onClose,
  canSave,
  startAt = 0,
  actions,
  caption,
  original,
  title,
  picked,
  onPick,
}: {
  photos: Photo[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  canSave: boolean;
  startAt?: number;
  actions?: (p: Photo) => ReactNode;
  /** The handwritten tag under the print ("that’s you!", "added by Priya"). */
  caption?: (p: Photo) => ReactNode;
  /** Where the full-quality original of a photo or video is downloaded from. */
  original?: (p: Photo) => string;
  /** The edge print over it ("Print 2 of 9"). */
  title?: (index: number, p: Photo) => string;
  /** With onPick: a Select button, pressed when picked(p). */
  picked?: (p: Photo) => boolean;
  onPick?: (p: Photo) => void;
}) {
  const p = photos[index];
  const video = !!p && isVideo(p);
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;
  const root = useRef<HTMLDivElement>(null);
  useFocusTrap(root);
  // Zoom: pinch, or tap twice; drag to move around; swipe sideways for the next photo when not zoomed.
  const box = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  /** A reload after the video's link ran out: where to go on, and whether it was playing. */
  const resumeAt = useRef<{ at: number; play: boolean } | null>(null);
  const lastReload = useRef(0);
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const [smooth, setSmooth] = useState(false);
  const g = useRef({ pts: new Map<number, { x: number; y: number }>(), x: 0, y: 0, zx: 0, zy: 0, s: 1, d: 0, moved: false, pinched: false, lastTap: 0 });
  // The download's state belongs to the photo it was started on: a late answer for another photo changes nothing here.
  // (Kept per photo: a photo left while its download runs still counts as busy when you come back to it.)
  const [troubleOf, setTroubleOf] = useState<Record<string, string | null>>({});
  const trouble = p ? (troubleOf[p.id] ?? null) : null;
  const sayFor = (id: string) => (s: string | null) => setTroubleOf((cur) => ({ ...cur, [id]: s }));
  useEffect(() => {
    setZoom({ s: 1, x: 0, y: 0 });
    setTroubleOf((cur) => Object.fromEntries(Object.entries(cur).filter(([, v]) => v === 'busy'))); // messages go, downloads still running stay
  }, [p?.id]);
  const fit = (s: number, x: number, y: number) => {
    const mx = ((box.current?.clientWidth ?? 0) * (s - 1)) / 2;
    const my = ((box.current?.clientHeight ?? 0) * (s - 1)) / 2;
    return { s, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  };
  const spread = () => {
    const [a, b] = [...g.current.pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const down = (e: React.PointerEvent) => {
    // A video's own controls and the buttons take the touches.
    if ((e.target as HTMLElement).closest('button, video')) return;
    const G = g.current;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    G.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setSmooth(false);
    if (G.pts.size === 1) Object.assign(G, { x: e.clientX, y: e.clientY, zx: zoom.x, zy: zoom.y, s: zoom.s, d: 0, moved: false, pinched: false });
    else if (G.pts.size === 2) Object.assign(G, { s: zoom.s, d: spread(), pinched: true });
  };
  const move = (e: React.PointerEvent) => {
    const G = g.current;
    if (!G.pts.has(e.pointerId)) return;
    G.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (G.pts.size === 2 && G.d > 0) {
      const s = Math.max(1, Math.min(4, (G.s * spread()) / G.d));
      setZoom((z) => fit(s, z.x, z.y));
      return;
    }
    const dx = e.clientX - G.x;
    const dy = e.clientY - G.y;
    if (Math.abs(dx) + Math.abs(dy) > 8) G.moved = true;
    if (G.pts.size === 1 && !G.pinched && G.s > 1) setZoom(fit(G.s, G.zx + dx, G.zy + dy));
  };
  const up = (e: React.PointerEvent, cancelled = false) => {
    const G = g.current;
    if (!G.pts.delete(e.pointerId) || G.pts.size > 0 || cancelled) return;
    if (G.pinched) {
      if (zoom.s < 1.08) {
        setSmooth(true);
        setZoom({ s: 1, x: 0, y: 0 });
      }
      return;
    }
    const dx = e.clientX - G.x;
    const dy = e.clientY - G.y;
    if (!G.moved) {
      if (video) return;
      const now = Date.now();
      if (now - G.lastTap > 320) {
        G.lastTap = now;
        return;
      }
      G.lastTap = 0; // the second tap: in on that spot, or back out
      const r = box.current!.getBoundingClientRect();
      setSmooth(true);
      setZoom(zoom.s > 1 ? { s: 1, x: 0, y: 0 } : fit(2.5, (r.left + r.width / 2 - e.clientX) * 1.5, (r.top + r.height / 2 - e.clientY) * 1.5));
      return;
    }
    if (G.s === 1 && e.pointerType !== 'mouse' && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0 && index < photos.length - 1) onIndex(index + 1);
      if (dx > 0 && index > 0) onIndex(index - 1);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Arrows in a text field (the reason for a report) move the caret, not the photo.
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
      if (e.key === 'ArrowRight' && index < photos.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', key);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = '';
    };
  }, [index, photos.length, onClose, onIndex]);
  if (!p) return null;
  const n = startAt + index + 1;
  const name = video ? `video-${n}.mp4` : `photo-${n}.jpg`;
  const file = video ? p.video! : p.web;
  const kind = video ? 'Video' : 'Photo';
  const note = caption?.(p) ?? (p.by ? `added by ${p.by}` : null);
  const heading = title?.(index, p) ?? `Frame ${index + 1} of ${photos.length}`;
  const on = !!picked?.(p);
  /** Share where the phone can share the file; otherwise the photo is saved instead. */
  const share = () => void sharePhoto(file, name).catch(() => sayFor(p.id)(`This ${kind.toLowerCase()} could not be shared.`));

  return (
    <div ref={root} className="viewer vw" role="dialog" aria-modal="true" aria-label={`${kind} ${n}`}>
      <div className="vw-top">
        <span className="edge-print lg">{heading}</span>
        <button type="button" className="vw-x" onClick={onClose} aria-label="Close">
          <Icon name="xmark" size={26} />
        </button>
      </div>
      <div className="vw-stage" onPointerDown={down} onPointerMove={move} onPointerUp={(e) => up(e)} onPointerCancel={(e) => up(e, true)}>
        <button type="button" className="vw-nav" aria-label="Previous" disabled={index === 0} onClick={() => onIndex(index - 1)}>
          <Icon name="back" size={26} />
        </button>
        <div ref={box} className={`vw-print ${video ? 'is-video' : ''}`}>
          {video ? (
            <video
              key={p.id}
              ref={player}
              src={p.video!}
              poster={p.web}
              controls
              playsInline
              preload="metadata"
              aria-label={`Video ${n}${p.duration_ms ? `, ${clock(p.duration_ms)}` : ''}`}
              // A video from your results starts a moment before you are seen in it; a reload goes on where it was.
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                const resume = resumeAt.current;
                if (resume) {
                  resumeAt.current = null;
                  v.currentTime = resume.at;
                  if (resume.play) void v.play()?.catch(() => {});
                } else if (p.at_ms != null) v.currentTime = startOf(p.at_ms);
              }}
              // The OneDrive link behind it lasts about an hour: a long viewing that outlives it loads a fresh one
              // and carries on at the same moment (once a minute at most).
              onError={(e) => {
                const v = e.currentTarget;
                const now = Date.now();
                if (now - lastReload.current < 60_000) return;
                lastReload.current = now;
                resumeAt.current = { at: v.currentTime || 0, play: v.currentTime > 0 || !v.paused };
                v.src = retried(p.video!, now);
                v.load();
              }}
            />
          ) : (
            <AlbumImg
              key={p.id}
              src={p.web}
              alt={p.by ? `Photo added by ${p.by}` : 'Event photo'}
              draggable={false}
              data-zoom={zoom.s.toFixed(2)}
              style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`, transition: smooth ? 'transform 0.18s ease-out' : 'none', cursor: zoom.s > 1 ? 'grab' : 'zoom-in' }}
            />
          )}
        </div>
        <button type="button" className="vw-nav" aria-label="Next" disabled={index >= photos.length - 1} onClick={() => onIndex(index + 1)}>
          <Icon name="chev" size={26} />
        </button>
      </div>
      <p className="vw-tag hand">{note}</p>
      <div className="vw-acts">
        {video && p.at_ms != null && (
          <button
            type="button"
            className="btn ghost jumpto"
            onClick={() => {
              const v = player.current;
              if (!v) return;
              v.currentTime = startOf(p.at_ms!);
              // (some browsers give no promise back from play())
              void v.play()?.catch(() => {});
            }}
          >
            <Icon name="play" size={16} /> You at {clock(p.at_ms) || '0:00'}
          </button>
        )}
        {canSave &&
          (original ? (
            <a className="btn primary vw-dl" href={original(p)} download={name} onClick={(e) => (trouble === 'busy' ? e.preventDefault() : fetchOriginal(e, original(p), name, sayFor(p.id)))} aria-busy={trouble === 'busy'}>
              <Icon name="download" size={22} />
              {trouble === 'busy' ? (
                <span>Getting the full quality…</span>
              ) : (
                <span>
                  Download {kind.toLowerCase()} <small>full quality</small>
                </span>
              )}
            </a>
          ) : (
            <button type="button" className="btn primary vw-dl" onClick={() => void savePhoto(file, name).catch(() => sayFor(p.id)(`This ${kind.toLowerCase()} could not be saved. Try again.`))}>
              <Icon name="download" size={22} /> Save
            </button>
          ))}
        {canSave && onPick && (
          <button type="button" className="btn ghost" aria-pressed={on} onClick={() => onPick(p)}>
            {on && <Icon name="check" size={18} />} {on ? 'Selected' : 'Select'}
          </button>
        )}
      </div>
      {trouble && trouble !== 'busy' && (
        <p className="slip bad vw-trouble" role="alert">
          {trouble}
        </p>
      )}
      <div className="vw-links">
        {actions?.(p)}
        {canSave && canShare && (
          <button type="button" className="linkbtn" onClick={share}>
            Share
          </button>
        )}
      </div>
    </div>
  );
}
