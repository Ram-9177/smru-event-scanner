import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { IconName } from './icons';
import { api, ApiError, niceDate, piped, size, uploadFile, type AdminAlert, type AlertSettings, type Campus, type Photo, type StorageReport } from './lib/api';
import { apiKey, under, useApi } from './lib/query';
import { NewPerson, People, PersonPage } from './people';
import { AlbumImg, Chips, DropZone, edgeDate, Empty, frameNo, Head, Icon, Lamp, Load, LogoPlate, Note, PencilCircle, Stamp, Tabs, Toggle, UploadList, VideoBadge, Viewer, type UploadItem } from './ui';

// The organiser console (web/DESIGN.md, "Organiser console"): the darkroom with the lights on. Paper cards on a dark bench,
// a dark top bar with the sections in condensed capitals on desktop, a bottom bar on phones. Sign-in is in the red-lit room.

interface AdminEvent {
  id: string;
  slug: string;
  title: string;
  starts_on: string | null;
  ends_on: string | null;
  venue: string | null;
  /** Older servers do not send it. */
  campus?: Campus | null;
  status: 'draft' | 'live' | 'closed' | 'archived';
  has_passcode: boolean;
  allow_download: boolean;
  face_enabled: boolean;
  listed: boolean;
  crowd_uploads: boolean;
  auto_approve: boolean;
  /** Dark or flat photos get a gentle fix in the album and in downloads (on unless switched off). */
  improve_photos?: boolean;
  folder: { id: string; name: string } | null;
  last_sync_at: string | null;
  sync_error: string | null;
  syncing: boolean;
  cover_media_id: string | null;
  /** A few of its photos for the event's card (organiser links): the cover first. */
  strip?: string[];
  link: string;
  counts: Record<'total' | 'waiting' | 'processing' | 'failed' | 'skipped' | 'copies' | 'shown' | 'review' | 'hidden' | 'faces' | 'no_faces', number> & { lost?: number };
  /** The album closes by itself on this day (YYYY-MM-DD). Older servers do not send these. */
  close_on?: string | null;
  /** Face data is deleted this many days after the event; null keeps it until the event is archived. */
  face_days?: number | null;
  face_expiry_at?: string | null;
  /** When the face data was deleted (expiry, archive or by hand): face search has ended. */
  face_deleted_at?: string | null;
  sync_failures?: number;
  /** Closed more than 90 days ago and its face data is still kept. */
  face_reminder?: boolean;
}
/** One photo or video in the admin lists. */
interface AdminMedia {
  id: string;
  name: string | null;
  type?: 'photo' | 'video';
  duration_ms?: number | null;
  video?: string | null;
  status: string;
  status_reason: string | null;
  review: string | null;
  hidden: boolean;
  source: string;
  duplicate_of: string | null;
  copy_of_name: string | null;
  face_count: number;
  uploader_name: string | null;
  thumb: string | null;
  web: string | null;
  /** Its copies cannot be made in OneDrive (the original is gone): not shown to students. */
  copies_lost?: boolean;
  copies_error?: string | null;
}
const asPhoto = (m: AdminMedia): Photo => ({ id: m.id, thumb: m.thumb ?? '', web: m.web ?? m.thumb ?? '', type: m.type, duration_ms: m.duration_ms, video: m.video, by: m.uploader_name });

interface MeInfo {
  user: { id: string; email: string; role: 'super_admin' | 'organiser' };
  org: string;
  public_url: string;
  drive: 'local' | 'graph';
  face_service: boolean;
  contact: string | null;
}

const MeCtx = createContext<MeInfo | null>(null);
/** An event's days: "20 Nov 2026", "14–16 Nov 2026", "30 Nov – 2 Dec 2026" or "30 Dec 2026 – 2 Jan 2027". */
function days(from: string | null, to: string | null): string {
  if (!from || !to || to <= from) return niceDate(from);
  const [a, b] = [niceDate(from).split(' '), niceDate(to).split(' ')];
  if (a[2] !== b[2]) return `${a.join(' ')} – ${b.join(' ')}`;
  if (a[1] !== b[1]) return `${a[0]} ${a[1]} – ${b.join(' ')}`;
  return `${a[0]}–${b.join(' ')}`;
}
const eventWhen = (e: { starts_on: string | null; ends_on?: string | null; venue: string | null }) => [days(e.starts_on, e.ends_on ?? null), e.venue].filter(Boolean).join(' · ');
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
/** A day the way alerts and face-data dates say it: 3 Dec 2026. */
const dayOf = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
/** A YYYY-MM-DD day plus n days. */
function addDays(day: string, n: number): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + n);
}

function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>{label}</b>
        {hint && <span className="muted block">{hint}</span>}
      </span>
    </label>
  );
}

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm soft"
      onClick={async () => {
        await navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={16} /> {done ? 'Copied' : label}
    </button>
  );
}

/** A card with a coloured icon chip and a title. */
function Section({ icon, colour = 'navy', title, edge, right, children }: { icon: IconName; colour?: string; title: string; edge?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className={`card ${edge ? `edge-${edge}` : ''}`}>
      <div className="card-h">
        <span className={`chip ${colour}`}>
          <Icon name={icon} size={18} />
        </span>
        <b>{title}</b>
        <span className="sp" />
        {right}
      </div>
      {children}
    </section>
  );
}

/** The progress ring of the kit. */
function Ring({ pct, size = 96, arc = 'var(--red)', track = 'var(--paper-2)' }: { pct: number; size?: number; arc?: string; track?: string }) {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const h = size / 2;
  return (
    <div className="pring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={h} cy={h} r={r} fill="none" strokeWidth="10" style={{ stroke: track }} />
        <circle cx={h} cy={h} r={r} fill="none" strokeWidth="10" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform={`rotate(-90 ${h} ${h})`} style={{ stroke: arc, transition: 'stroke-dashoffset .4s' }} />
      </svg>
      <b>{pct}%</b>
    </div>
  );
}

/** Step-by-step results of a check: a green tick, an orange ! or a red cross per step. */
function Steps({ steps }: { steps: { step: string; ok: boolean; warn?: boolean; detail: string }[] }) {
  return (
    <ul className="steps" aria-label="Result of the check">
      {steps.map((s) => (
        <li key={s.step}>
          <span className={`chip ${s.ok ? (s.warn ? 'orange' : 'green') : 'red'}`}>
            <Icon name={s.ok ? (s.warn ? 'alert' : 'check') : 'xmark'} size={14} />
          </span>
          <span className={s.ok ? '' : 'text-warn font-semibold'}>
            {s.step}: <span className="muted font-normal">{s.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---- B1: sign in ---------------------------------------------------------------------
const AUTH_OPTIONS = '/admin/auth/options';

/** The Microsoft logo: four squares. */
function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

/**
 * The organisers' way in: the red-lit room with the safelight, the title on the dark, the form on a paper card.
 * Sign-in, forgot and reset share it. `after` goes under the card, on the dark (the Microsoft button).
 */
function AuthCard({ title, line, children, after, foot }: { title: ReactNode; line?: ReactNode; children: ReactNode; after?: ReactNode; foot?: ReactNode }) {
  return (
    <main className="room auth">
      <div className="glow" aria-hidden />
      <header className="auth-top">
        <span className="auth-brand">
          <LogoPlate small />
          <span className="wordmark">Event Photos</span>
        </span>
        <Lamp />
      </header>
      <div className="auth-grid">
        <div className="auth-intro">
          <p className="edge-print">Organisers · Event Photos</p>
          <h1>{title}</h1>
          {line && <p className="lead">{line}</p>}
        </div>
        <div className="auth-in">
          <section className="card auth-card">{children}</section>
          {after}
          {foot && <div className="auth-foot">{foot}</div>}
        </div>
      </div>
    </main>
  );
}

function Login() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // A failed Microsoft sign-in comes back as ?sso_error=...: the message stays on screen, the address is tidied.
  const [ssoError] = useState(() => params.get('sso_error'));
  useEffect(() => {
    if (!params.has('sso_error')) return;
    const rest = new URLSearchParams(params);
    rest.delete('sso_error');
    setParams(rest, { replace: true });
  }, [params, setParams]);
  // Nothing read during an earlier sign-in may show after the next one.
  useEffect(() => {
    qc.removeQueries({ predicate: (q) => under('/admin').predicate(q) && q.queryKey[1] !== AUTH_OPTIONS });
  }, [qc]);
  const options = useApi<{ microsoft: boolean }>(AUTH_OPTIONS, { staleTime: Infinity });
  const login = useMutation({
    mutationFn: () => api('/admin/login', { json: { email, password } }),
    onSuccess: () => nav('/admin', { replace: true }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <AuthCard
      title={
        <>
          Organiser <span className="g">sign in</span>
        </>
      }
      line="Run events, add photos and videos, and approve what students send."
      after={
        options.data?.microsoft && (
          <div className="auth-sso">
            <p className="auth-or" aria-hidden>
              or
            </p>
            <a className="btn ghost big w-full" href="/auth/microsoft">
              <MicrosoftMark /> Sign in with Microsoft
            </a>
          </div>
        )
      }
      foot={
        <p className="muted small m-0">
          Students do not sign in. <Link to="/">Go to Event Photos</Link>
        </p>
      }
    >
      {ssoError && <Note bad>{ssoError}</Note>}
      <form onSubmit={submit}>
        <label htmlFor="email" className="mt-0">
          Email <span className="req">*</span>
        </label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <label htmlFor="password">
          Password <span className="req">*</span>
        </label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {login.error && <Note bad>{login.error.message}</Note>}
        <button type="submit" className="btn primary big w-full mt-5" disabled={login.isPending}>
          Sign in
        </button>
        <p className="auth-forgot small text-center mt-3 mb-0">
          <Link to="/admin/forgot">Forgot password?</Link>
        </p>
      </form>
    </AuthCard>
  );
}

/** Forgot password: the server emails a link to /admin/reset. It answers the same whether the email is known or not. */
function ForgotPassword() {
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: () => api('/admin/password/forgot', { json: { email } }) });
  return (
    <AuthCard
      title={
        <>
          Forgot your <span className="g">password?</span>
        </>
      }
      line={send.isSuccess ? undefined : 'Type the email you sign in with. We send you a link to set a new password.'}
      foot={
        !send.isSuccess && (
          <Link className="small" to="/admin/login">
            Back to sign in
          </Link>
        )
      }
    >
      {send.isSuccess ? (
        <>
          <Note kind="ok">If that email belongs to a team member, we have sent a link to reset the password. It works for 30 minutes.</Note>
          <Link className="btn big w-full mt-4" to="/admin/login">
            Back to sign in
          </Link>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <label htmlFor="forgot-email" className="mt-0">
            Email <span className="req">*</span>
          </label>
          <input id="forgot-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          {send.error && <Note bad>{send.error.message}</Note>}
          <button type="submit" className="btn primary big w-full mt-5" disabled={send.isPending}>
            <Icon name="mail" size={18} /> {send.isPending ? 'Sending…' : 'Send the link'}
          </button>
        </form>
      )}
    </AuthCard>
  );
}

const MIN_RESET = 10;

/** The page the emailed link opens: /admin/reset?token=... */
function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const reset = useMutation({ mutationFn: () => api('/admin/password/reset', { json: { token, password } }) });
  const expired = reset.error instanceof ApiError && reset.error.code === 'invalid_token';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_RESET) return setProblem(`Use ${MIN_RESET} characters or more.`);
    if (password !== repeat) return setProblem('The two passwords are not the same.');
    setProblem(null);
    reset.mutate();
  };
  return (
    <AuthCard
      title={
        <>
          Set a new <span className="g">password</span>
        </>
      }
    >
      {reset.isSuccess ? (
        <>
          <Note kind="ok">Your new password is saved.</Note>
          <Link className="btn primary big w-full mt-4" to="/admin/login">
            Sign in
          </Link>
        </>
      ) : !token || expired ? (
        <>
          <Note bad>{token ? 'This link has expired or was already used. Ask for a new one.' : 'This link is not complete. Ask for a new one.'}</Note>
          <Link className="btn primary big w-full mt-4" to="/admin/forgot">
            Ask for a new link
          </Link>
        </>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="reset-pass" className="mt-0">
            New password <span className="req">*</span> <small>({MIN_RESET} characters or more)</small>
          </label>
          <input id="reset-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          <label htmlFor="reset-repeat">
            Repeat the new password <span className="req">*</span>
          </label>
          <input id="reset-repeat" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
          {(problem || reset.error) && <Note bad>{problem ?? reset.error?.message}</Note>}
          <button type="submit" className="btn primary big w-full mt-5" disabled={reset.isPending}>
            <Icon name="shield" size={18} /> {reset.isPending ? 'Saving…' : 'Save the new password'}
          </button>
        </form>
      )}
    </AuthCard>
  );
}

/** The problems the server found (GET /admin/alerts), one banner each across the console: critical in red, the rest in amber. */
function AlertBanners({ alerts }: { alerts: AdminAlert[] }) {
  if (!alerts.length) return null;
  return (
    <div className="alertbars">
      {alerts.map((a) => (
        <div key={a.key} className={`alertbar ${a.severity === 'critical' ? 'critical' : 'warn'}`} role={a.severity === 'critical' ? 'alert' : 'status'}>
          <Icon name="alert" size={20} />
          <div className="alertbar-tx">
            <b>{a.title}</b>
            {a.detail && <span>{a.detail}</span>}
          </div>
          {a.action && (
            <Link className="btn sm" to={a.action.to}>
              {a.action.label}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

function Shell() {
  const nav = useNavigate();
  const { search, pathname } = useLocation();
  const meQuery = useApi<MeInfo>('/admin/me');
  // Read again every minute and when the organiser comes back to the tab; the server checks again when its last look is a minute old.
  const alerts = useApi<{ alerts: AdminAlert[] }>('/admin/alerts', { enabled: !!meQuery.data, refetchInterval: 60_000, refetchOnWindowFocus: true });
  const requests = useApi<{ requests: unknown[] }>('/admin/requests');
  const events = useApi<{ events: AdminEvent[] }>('/admin/events');
  const me = meQuery.data;
  const open = requests.data?.requests.length ?? 0;
  const waiting = events.data?.events.reduce((n, e) => n + (e.counts?.review ?? 0), 0) ?? 0;
  const signedOut = meQuery.error instanceof ApiError && meQuery.error.status === 401;
  useEffect(() => {
    if (!signedOut) return;
    // A failed Microsoft sign-in lands on /admin?sso_error=...: the sign-in screen shows the message.
    const sso = new URLSearchParams(search).get('sso_error');
    nav({ pathname: '/admin/login', search: sso ? `?${new URLSearchParams({ sso_error: sso })}` : '' }, { replace: true });
  }, [signedOut, search, nav]);
  if (!me)
    return (
      <div className="empty" role="status">
        Loading…
      </div>
    );
  const on = ({ isActive }: { isActive: boolean }) => (isActive ? 'on' : '');
  const onEvents = ({ isActive }: { isActive: boolean }) => (isActive || pathname.startsWith('/admin/events') ? 'on' : '');
  const signOut = async () => {
    await api('/admin/logout', { method: 'POST' });
    nav('/admin/login');
  };
  const badge = (n: number, what: string, cls: string) =>
    n > 0 && (
      <span className={cls}>
        {n}
        <span className="sr-only"> {what}</span>
      </span>
    );
  const links = (
    <>
      <NavLink to="/admin" end className={onEvents}>
        Events
        {badge(waiting, 'waiting for approval', 'n')}
      </NavLink>
      <NavLink to="/admin/requests" className={on}>
        Requests
        {badge(open, 'open', 'n')}
      </NavLink>
      <NavLink to="/admin/people" className={on}>
        People
      </NavLink>
      <NavLink to="/admin/share" className={on}>
        Share kit
      </NavLink>
      <NavLink to="/admin/settings" className={on}>
        Settings
      </NavLink>
    </>
  );
  // The red button of the phone bar follows the section: on an event it adds photos to it, under People it adds
  // a person (as the page's own Add person button does), anywhere else it makes a new event.
  const onEvent = /^\/admin\/events\/(?!new$)[^/]+$/.test(pathname);
  const onPeople = /^\/admin\/people(\/|$)/.test(pathname);
  const fab = onEvent
    ? { to: `${pathname}?tab=add`, label: 'Add photos and videos to this event', icon: 'upload' as const }
    : onPeople
      ? { to: '/admin/people/new', label: 'Add a person', icon: 'plus' as const }
      : { to: '/admin/events/new', label: 'New event', icon: 'plus' as const };
  return (
    <MeCtx.Provider value={me}>
      <header className="top console-top">
        <Link className="logo" to="/admin" aria-label="Event Photos, organiser console">
          <img src="/logo-mark.png" alt="" />
          <span className="wm">Event Photos</span>
          <small className="console-tag" aria-hidden>
            Console
          </small>
        </Link>
        <nav aria-label="Admin">{links}</nav>
        <span className="sp" />
        <div className="who">
          <b>{me.user.email}</b>
          <br />
          <span className="muted">
            {me.user.role === 'super_admin' ? 'Super admin' : 'Organiser'} · {me.org}
          </span>
        </div>
        {/* Requests is in the top bar on a computer; on a phone the bell takes its place. */}
        <Link className={`iconbtn phone-only ${pathname.startsWith('/admin/requests') ? 'on' : ''}`} to="/admin/requests" aria-label={open ? `Reports from students: ${open} open` : 'Reports from students'} title="Reports from students">
          <Icon name="bell" size={18} />
          {open > 0 && (
            <span className="dotbadge" aria-hidden>
              {open}
            </span>
          )}
        </Link>
        <button className="iconbtn" onClick={signOut} aria-label="Sign out" title="Sign out">
          <Icon name="logout" size={18} />
        </button>
      </header>
      <main className="page console">
        {alerts.data ? (
          <AlertBanners alerts={alerts.data.alerts ?? []} />
        ) : (
          // Without the alerts (an older server, or the read failed) the one problem the console knows of by itself.
          alerts.isError &&
          !me.face_service && (
            <Note bad title="Face recognition is not ready">
              New photos cannot be processed yet. Restart the app; if this stays, the face model files in <code>server/models</code> are missing.
            </Note>
          )
        )}
        <Outlet />
      </main>
      <nav className="bnav" aria-label="Admin, phone">
        <NavLink to="/admin" end className={onEvents}>
          <Icon name="grid" size={22} /> Events
          {badge(waiting, 'waiting for approval', 'dot')}
        </NavLink>
        <NavLink to="/admin/people" className={on}>
          <Icon name="users" size={22} /> People
        </NavLink>
        <Link className="fab" to={fab.to} aria-label={fab.label} title={fab.label}>
          <Icon name={fab.icon} size={26} />
        </Link>
        <NavLink to="/admin/share" className={on}>
          <Icon name="qr" size={22} /> Share
        </NavLink>
        <NavLink to="/admin/settings" className={on}>
          <Icon name="settings" size={22} /> Settings
        </NavLink>
      </nav>
    </MeCtx.Provider>
  );
}

// ---- B2: events ------------------------------------------------------------------------
/** The campuses, for the filter chips and the campus pickers. An older server has none: then nothing shows. */
function useCampuses() {
  return useApi<{ campuses: (Campus & { events?: number })[] }>('/admin/campuses', { staleTime: 60_000 });
}

/** The state of an event as a rubber stamp; an open event carries the red recording dot. */
function StatePill({ state }: { state: AdminEvent['status'] }) {
  return state === 'live' ? <span className="pill stamp green live">Open</span> : <Stamp state={state} />;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/** The dashboard: what needs approval first, the numbers, then every event as a frame on the roll. */
function Events() {
  const me = useContext(MeCtx)!;
  const list = useApi<{ events: AdminEvent[] }>('/admin/events');
  const asked = useApi<{ requests: { kind?: string }[] }>('/admin/requests').data?.requests ?? [];
  const removals = asked.filter((q) => q.kind === 'removal').length;
  const reports = asked.length - removals;
  const campuses = useCampuses().data?.campuses;
  const [params, setParams] = useSearchParams();
  const campus = params.get('campus') ?? '';
  const all = list.data?.events ?? [];
  const events = campus ? all.filter((e) => e.campus?.id === campus) : all;
  const pending = all.filter((e) => e.counts.review > 0);
  const waiting = pending.reduce((n, e) => n + e.counts.review, 0);
  const kpis: { n: number; label: string; hot?: boolean }[] = [
    { n: all.length, label: all.length === 1 ? 'Event' : 'Events' },
    { n: all.filter((e) => e.status === 'live').length, label: 'Open now' },
    { n: all.reduce((n, e) => n + e.counts.shown, 0), label: 'In the albums' },
    { n: waiting, label: 'To approve', hot: waiting > 0 },
  ];
  return (
    <>
      <div className="hello">
        <div className="min-w-0">
          <p className="eyebrow">
            {greeting()} · {me.org}
          </p>
          <h1>Events</h1>
        </div>
        <Link className="btn primary hide-phone" to="/admin/events/new">
          <Icon name="plus" size={18} /> New event
        </Link>
      </div>

      {/* What needs approval comes first: a slip on the bench, one line per event. */}
      {list.data && (pending.length > 0 || asked.length > 0) && (
        <section className="slip needs" aria-labelledby="needs-h">
          <div className="needs-h">
            <span className="rec-dot" aria-hidden />
            <h2 id="needs-h">Needs your approval</h2>
          </div>
          <p className="needs-line">
            {pending.length > 0
              ? "Students' photos and videos stay out of the album until you approve them."
              : removals === 0 && reports === 1
                ? 'A student asked for a photo to come down. Hide it or keep it.'
                : reports === 0 && removals === 1
                  ? 'A student asked to be removed from photos. Take them out of the album or keep them.'
                  : 'Students asked for photos to come down. Hide each one or keep it.'}
          </p>
          <ul className="needs-list">
            {/* The count badge is for the eye only: the row's words already say it. */}
            {pending.map((e) => (
              <li key={e.id}>
                <Link className="needs-row" to={`/admin/events/${e.id}?tab=waiting`}>
                  <span className="n" aria-hidden>
                    {e.counts.review}
                  </span>
                  <span className="t">{`${e.title}: ${e.counts.review} waiting`}</span>{' '}
                  <span className="go">
                    Review <Icon name="chev" size={16} />
                  </span>
                </Link>
              </li>
            ))}
            {reports > 0 && (
              <li>
                <Link className="needs-row" to="/admin/requests">
                  <span className="n" aria-hidden>
                    {reports}
                  </span>
                  <span className="t">{reports === 1 ? 'A photo was reported by a student' : `${reports} photos were reported by students`}</span>{' '}
                  <span className="go">
                    Check <Icon name="chev" size={16} />
                  </span>
                </Link>
              </li>
            )}
            {removals > 0 && (
              <li>
                <Link className="needs-row" to="/admin/requests">
                  <span className="n" aria-hidden>
                    {removals}
                  </span>
                  <span className="t">{removals === 1 ? 'A student asked to be removed from photos' : `${removals} students asked to be removed from photos`}</span>{' '}
                  <span className="go">
                    Check <Icon name="chev" size={16} />
                  </span>
                </Link>
              </li>
            )}
          </ul>
        </section>
      )}

      {/* The numbers, in the frame counter's window. */}
      {list.data && all.length > 0 && (
        <div className="kpis console-kpis">
          {kpis.map((k) => (
            <div key={k.label} className={`kpi ${k.hot ? 'hot' : ''}`}>
              <b>{k.n}</b>
              <span>{k.label}</span>
            </div>
          ))}
        </div>
      )}

      {!!campuses?.length && (
        <Chips
          label="Campus"
          value={campus}
          onChange={(k) => setParams(k ? { campus: k } : {}, { replace: true })}
          items={[{ key: '', label: 'All' }, ...campuses.map((c) => ({ key: c.id, label: c.name, count: all.filter((e) => e.campus?.id === c.id).length }))]}
        />
      )}
      <Load query={list}>
        {events.length === 0 ? (
          <div className="card">
            <Empty icon="calendar" title={campus ? 'No events at this campus yet' : 'No events yet'}>
              Make one, then add its photos and videos.
            </Empty>
            <div className="text-center">
              <Link className="btn primary" to="/admin/events/new">
                <Icon name="plus" size={18} /> New event
              </Link>
            </div>
          </div>
        ) : (
          <div className="cards evcards">
            {/* Each event is a frame card: four frames of its roll on a strip of film, the edge print with its date and state, then the paper. */}
            {events.map((e, i) => {
              const card = (
              <Link key={e.id} className="item evframe" to={`/admin/events/${e.id}`}>
                <div className="evframe-film on-dark" aria-hidden>
                  <div className="evframe-edge">
                    <span>{edgeDate(e.starts_on)}</span>
                    <span>{e.status === 'live' ? 'Now showing' : e.status === 'draft' ? 'Not open yet' : e.status === 'closed' ? 'Closed' : 'Archived'}</span>
                  </div>
                  <div className="evframe-frames">
                    {Array.from({ length: 4 }, (_, k) => (e.strip?.[k] ? <AlbumImg key={k} src={e.strip[k]} alt="" loading="lazy" /> : <span key={k} className="blank" />))}
                  </div>
                  <div className="evframe-no">
                    <span>No. {frameNo(i)}</span>
                    <span>{e.counts.total} on the roll</span>
                  </div>
                </div>
                <div className="evframe-body">
                  <div className="item-top">
                    <StatePill state={e.status} />
                    <span className="sp" />
                    <span className="item-no">{e.counts.shown} photos</span>
                  </div>
                  <div className="item-title">{e.title}</div>
                  <div className="item-row">
                    <Icon name="calendar" size={16} />
                    <span>{days(e.starts_on, e.ends_on) || 'No date'}</span>
                  </div>
                  {e.campus && (
                    <div className="item-row">
                      <Icon name="pin" size={16} />
                      <span>{e.campus.name}</span>
                    </div>
                  )}
                  <div className="item-foot">
                    {e.sync_error ? (
                      <span className="bad">{e.sync_error}</span>
                    ) : (
                      <span className="fold">
                        <Icon name="folder" size={15} /> <span>{e.folder ? e.folder.name : 'No folder yet'}</span>
                      </span>
                    )}
                    {e.counts.review > 0 && <span className="pill stamp red ml-auto">{e.counts.review} waiting for approval</span>}
                  </div>
                </div>
              </Link>
              );
              // A closed event's face data that is still kept after 90 days: a slip under its card, with the button to delete it.
              return e.status === 'closed' && e.face_reminder ? (
                <div key={e.id} className="evwrap">
                  {card}
                  <FaceReminder e={e} />
                </div>
              ) : (
                card
              );
            })}
          </div>
        )}
      </Load>
    </>
  );
}

/** "Closed more than 90 days ago. Face data is still kept." Two taps delete it; the photos stay. */
function FaceReminder({ e }: { e: AdminEvent }) {
  const qc = useQueryClient();
  const [ask, setAsk] = useState(false);
  const del = useMutation({
    mutationFn: () => api(`/admin/events/${e.id}/face-data/delete`, { method: 'POST' }),
    onSuccess: () => {
      setAsk(false);
      void qc.invalidateQueries({ queryKey: apiKey('/admin/events') });
      void qc.invalidateQueries(under(`/admin/events/${e.id}`));
    },
  });
  return (
    <div className="slip facerem" role="group" aria-label={`Face data of ${e.title}`}>
      {ask ? (
        <>
          <p className="m-0">Delete the face data of {e.title}? Face search ends for this event. The photos stay.</p>
          <div className="facerem-acts">
            <button type="button" className="btn sm danger solid" onClick={() => del.mutate()} disabled={del.isPending}>
              <Icon name="trash" size={16} /> {del.isPending ? 'Deleting…' : 'Delete face data'}
            </button>
            <button type="button" className="btn sm" onClick={() => setAsk(false)} disabled={del.isPending}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="m-0">Closed more than 90 days ago. Face data is still kept.</p>
          <div className="facerem-acts">
            <button type="button" className="btn sm danger" onClick={() => setAsk(true)}>
              <Icon name="trash" size={16} /> Delete face data now
            </button>
          </div>
        </>
      )}
      {del.error && <Note bad>{del.error.message}</Note>}
    </div>
  );
}

// ---- B3: event setup ----------------------------------------------------------------------
interface EventForm {
  title: string;
  starts_on: string;
  /** The last day of an event over more days; empty for one day. */
  ends_on: string;
  campus_id: string;
  venue: string;
  passcode: string;
  allow_download: boolean;
  face_enabled: boolean;
  listed: boolean;
  crowd_uploads: boolean;
  auto_approve: boolean;
  improve_photos: boolean;
  /** The album closes by itself on this day; empty: it stays as it is. */
  close_on: string;
  /** Days after the event until its face data is deleted, as typed; empty keeps it until the event is archived. */
  face_days: string;
}
/** A new event deletes its face data 90 days after the event unless the organiser changes it. */
const NEW_FACE_DAYS = '90';
const blank: EventForm = {
  title: '',
  starts_on: '',
  ends_on: '',
  campus_id: '',
  venue: '',
  passcode: '',
  allow_download: true,
  face_enabled: true,
  listed: true,
  crowd_uploads: true,
  auto_approve: false,
  improve_photos: true,
  close_on: '',
  face_days: NEW_FACE_DAYS,
};

/** When the face data goes, from the form: the last day (or the date) plus N days. Null without a date or a number. */
function faceDate(f: Pick<EventForm, 'starts_on' | 'ends_on' | 'face_days'>): Date | null {
  const day = f.ends_on || f.starts_on;
  const n = Number(f.face_days);
  if (!day || !f.face_days.trim() || !Number.isInteger(n) || n < 1 || n > 3650) return null;
  return addDays(day, n);
}

/** Title, date and campus; everything else under More options. */
function EventFields({ f, set, hasPasscode, faceDeletedAt }: { f: EventForm; set: (p: Partial<EventForm>) => void; hasPasscode?: boolean; faceDeletedAt?: string | null }) {
  const campuses = useCampuses().data?.campuses;
  const until = faceDate(f);
  return (
    <>
      <label htmlFor="ev-title" className="mt-0!">
        Title <span className="req">*</span>
      </label>
      <input id="ev-title" value={f.title} onChange={(e) => set({ title: e.target.value })} required minLength={2} maxLength={120} placeholder="Annual Day 2026" />
      <div className="row">
        <div>
          <label htmlFor="ev-date">Date</label>
          <input id="ev-date" type="date" value={f.starts_on} onChange={(e) => set({ starts_on: e.target.value })} />
        </div>
        <div>
          <label htmlFor="ev-end">
            Last day <small>(if it runs over more days)</small>
          </label>
          <input id="ev-end" type="date" value={f.ends_on} min={f.starts_on || undefined} onChange={(e) => set({ ends_on: e.target.value })} />
        </div>
        {campuses && (
          <div>
            <label htmlFor="ev-campus">Campus</label>
            <select id="ev-campus" value={f.campus_id} onChange={(e) => set({ campus_id: e.target.value })}>
              <option value="">No campus</option>
              {campuses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <details className="more">
        <summary>More options</summary>
        <div className="in">
          <label htmlFor="ev-venue" className="mt-1!">
            Venue
          </label>
          <input id="ev-venue" value={f.venue} onChange={(e) => set({ venue: e.target.value })} maxLength={120} placeholder="Main hall" />
          <label htmlFor="ev-pass">
            Album passcode <small>(optional. Only "See all photos" asks for it; Find my photos stays open)</small>
          </label>
          <input id="ev-pass" value={f.passcode} onChange={(e) => set({ passcode: e.target.value })} minLength={4} maxLength={32} autoComplete="off" placeholder={hasPasscode ? 'A passcode is set. Type a new one to change it' : 'Leave empty for an open album'} />
          <div className="mt-3">
            <Check label="Face search" hint="Switch off for events with under-18s until parental consent is in place: the event is then album-only." checked={f.face_enabled} onChange={(v) => set({ face_enabled: v })} />
            <Check label="Downloads" hint="Students can save photos and download all of theirs as a ZIP." checked={f.allow_download} onChange={(v) => set({ allow_download: v })} />
            <Check label="Show on the events list" hint="Off: only people with the event's own link find it." checked={f.listed} onChange={(v) => set({ listed: v })} />
            <Check label="Students can add photos and videos" hint="Saved into a Crowd uploads folder inside the event's OneDrive folder. Copies are skipped." checked={f.crowd_uploads} onChange={(v) => set({ crowd_uploads: v })} />
            <Check label="Show students' photos without approval" hint="Off (the default): each one waits under Waiting for approval until you approve it." checked={f.auto_approve} onChange={(v) => set({ auto_approve: v })} />
            <Check
              label="Improve photos automatically"
              hint="A dark or dull photo gets a gentle fix (brightness, contrast, colour) in the album and in its full-quality download. Good photos stay as they are, and the originals in OneDrive never change."
              checked={f.improve_photos}
              onChange={(v) => set({ improve_photos: v })}
            />
          </div>
          <div className="form-section">
            <b>After the event</b>
            <label htmlFor="ev-close">Close the album automatically on</label>
            <input id="ev-close" type="date" value={f.close_on} onChange={(e) => set({ close_on: e.target.value })} aria-describedby="ev-close-hint" />
            <p id="ev-close-hint" className="muted small mt-1 mb-0">
              It closes that morning: students can still see the photos, nothing new is added.
            </p>
            <label htmlFor="ev-facedays">Delete face data</label>
            <div className="facedays">
              <input
                id="ev-facedays"
                type="number"
                inputMode="numeric"
                value={f.face_days}
                disabled={!!faceDeletedAt}
                onChange={(e) => set({ face_days: e.target.value })}
                aria-describedby="ev-facedays-unit ev-facedays-hint ev-facedays-when"
              />
              <span id="ev-facedays-unit">days after the event</span>
            </div>
            <p id="ev-facedays-hint" className="muted small mt-1 mb-0">
              Face search stops then; the photos stay. Leave empty to keep it until you archive the event.
            </p>
            <p id="ev-facedays-when" className="facedays-when small mt-2 mb-0" aria-live="polite">
              {faceDeletedAt ? `Face data deleted on ${dayOf(new Date(faceDeletedAt))}.` : until ? `Face data will be deleted on ${dayOf(until)}.` : ''}
            </p>
          </div>
        </div>
      </details>
    </>
  );
}

const formBody = (f: EventForm) => ({
  ...f,
  campus_id: f.campus_id || null,
  starts_on: f.starts_on || null,
  ends_on: f.ends_on || null,
  venue: f.venue || null,
  close_on: f.close_on || null,
  face_days: f.face_days.trim() ? Number(f.face_days) : null,
});
/** The last day needs a first day, on or before it; the days until face data goes are a whole number. */
const datesWrong = (f: EventForm) => {
  if (f.ends_on && !f.starts_on) return 'Set the date of the first day too.';
  if (f.ends_on && f.ends_on < f.starts_on) return 'The last day must be on or after the first day.';
  const n = Number(f.face_days);
  if (f.face_days.trim() && (!Number.isInteger(n) || n < 1 || n > 3650)) return 'Delete face data: type a number of days from 1 to 3650, or leave it empty.';
  return null;
};

function NewEvent() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<EventForm>(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(datesWrong(f));
    if (datesWrong(f)) return;
    setBusy(true);
    try {
      const { passcode, ...rest } = formBody(f);
      const { event, folder_error } = await api<{ event: AdminEvent; folder_error: string | null }>('/admin/events', { json: { ...rest, ...(passcode ? { passcode } : {}) } });
      void qc.invalidateQueries({ queryKey: apiKey('/admin/events') });
      nav(`/admin/events/${event.id}`, { state: { folderError: folder_error, fresh: true } });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="newev">
      <Head back="/admin" title="New event" />
      <div className="card newev-card">
        <p className="eyebrow mb-1">Step 1 of 2 · The basics</p>
        <p className="muted small mt-0 mb-4">Only the title is needed. Everything else can wait.</p>
        <EventFields f={f} set={(p) => setF((x) => ({ ...x, ...p }))} />
        {error && <Note bad>{error}</Note>}
        <button className="btn primary big w-full mt-5" disabled={busy}>
          <Icon name="plus" size={18} /> {busy ? 'Making the event…' : 'Create the event'}
        </button>
        <p className="muted small mt-3 mb-0">Step 2: add its photos and videos. Students see it as "Coming soon" until you open it.</p>
      </div>
    </form>
  );
}

// ---- B4, B5, B6: one event -------------------------------------------------------------------
const STATES: { key: AdminEvent['status']; label: string; what: string }[] = [
  { key: 'draft', label: 'Coming soon', what: 'Students see the event, but cannot search yet. They can already add photos.' },
  { key: 'live', label: 'Open', what: 'Students can find their photos, see the album and add photos.' },
  { key: 'closed', label: 'Closed', what: 'Photos stay visible. No new photos, no more syncing.' },
  { key: 'archived', label: 'Archived', what: 'Hidden from students and the face data is deleted. To bring it back: Open it, then Read every photo again.' },
];

/** Photos still being synced or read: the counters move by themselves. */
const reading = (e?: AdminEvent) => !!e && (e.syncing || e.counts.waiting + e.counts.processing > 0);

type EventTab = 'add' | 'waiting' | 'photos' | 'settings';
/** Older links: ?tab=overview, sync, photos, settings. */
const TAB_OF: Record<string, EventTab> = { add: 'add', waiting: 'waiting', review: 'waiting', photos: 'photos', media: 'photos', settings: 'settings', sync: 'settings' };

function EventPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const path = `/admin/events/${id}`;
  // While a sync runs, refresh the counters.
  const event = useApi<{ event: AdminEvent }>(path, { refetchInterval: (q) => (reading(q.state.data?.event) ? 1500 : false) });
  const [error, setError] = useState<string | null>(null);
  const e = event.data?.event;
  // The tab to open on: what needs doing first.
  const [first, setFirst] = useState<EventTab | null>(null);
  useEffect(() => {
    if (e && !first) setFirst(e.counts.review > 0 ? 'waiting' : e.counts.total === 0 ? 'add' : 'photos');
  }, [e, first]);
  const tab: EventTab = TAB_OF[params.get('tab') ?? ''] ?? first ?? 'add';

  /** Read the event again, with its photo lists and the events list. */
  const reload = useCallback(() => {
    void qc.invalidateQueries(under(path));
    void qc.invalidateQueries({ queryKey: apiKey('/admin/events') });
  }, [qc, path]);

  // The photo lists follow the counters: when a sync, an upload or a review moves them, the lists are read again.
  const counts = e ? [e.counts.total, e.counts.shown, e.counts.review, e.counts.hidden, e.counts.copies, e.counts.failed, e.counts.skipped].join() : '';
  const seen = useRef(counts);
  useEffect(() => {
    if (seen.current && counts && seen.current !== counts) void qc.invalidateQueries(under(`${path}/media`));
    seen.current = counts;
  }, [counts, qc, path]);

  const patch = async (body: unknown) => {
    setError(null);
    try {
      qc.setQueryData(apiKey(path), await api<{ event: AdminEvent }>(path, { method: 'PATCH', json: body }));
      void qc.invalidateQueries({ queryKey: apiKey('/admin/events') });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  const sync = async () => {
    setError(null);
    try {
      await api(`${path}/sync`, { method: 'POST' });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Load query={event}>
      {e && (
        <>
          <Head back="/admin" title={e.title}>
            <StatePill state={e.status} />
          </Head>
          {/* The event's line of edge print: when, where, how many. */}
          <p className="evmeta edge-print">
            <span>{eventWhen(e) || 'No date set'}</span>
            {e.campus && <span>{e.campus.name}</span>}
            <span>{e.counts.shown} in the album</span>
            {e.face_deleted_at && <span>Face data deleted on {dayOf(new Date(e.face_deleted_at))}</span>}
          </p>
          <ShareCard e={e} patch={patch} />
          {error && <Note bad>{error}</Note>}
          <NextStep e={e} tab={tab} go={(k) => setParams({ tab: k }, { replace: true })} />
          <Tabs<EventTab>
            label="This event"
            value={tab}
            onChange={(k) => setParams({ tab: k }, { replace: true })}
            items={[
              { key: 'add', label: 'Add photos & videos' },
              { key: 'waiting', label: `Waiting for approval (${e.counts.review})`, hot: e.counts.review > 0 },
              { key: 'photos', label: 'Photos & videos' },
              { key: 'settings', label: 'OneDrive & settings' },
            ]}
          />
          <div role="tabpanel">
            {tab === 'add' && <AddMedia e={e} reload={reload} />}
            {tab === 'waiting' && <Waiting e={e} reload={reload} />}
            {tab === 'photos' && <Photos e={e} reload={reload} patch={patch} />}
            {tab === 'settings' && (
              <div className="max-w-[880px]">
                <SyncTab e={e} patch={patch} sync={sync} reload={reload} />
                <EventSettings e={e} patch={patch} />
              </div>
            )}
          </div>
        </>
      )}
    </Load>
  );
}

type TabProps = { e: AdminEvent; patch: (b: unknown) => Promise<boolean>; sync: () => Promise<void>; reload: () => void };

/** The event's link and QR, and the one switch that opens it to students. The QR is a Polaroid, captioned by hand. */
function ShareCard({ e, patch }: { e: AdminEvent; patch: (b: unknown) => Promise<boolean> }) {
  const me = useContext(MeCtx)!;
  // The event's own QR; a server without it gives the one QR of the events list.
  const [own, setOwn] = useState(true);
  const qr = own ? `/api/admin/events/${e.id}/qr` : '/api/admin/qr';
  const shut = e.status === 'closed' || e.status === 'archived';
  const live = e.status === 'live';
  return (
    <section className="card share" aria-label="Share with students">
      <a className="share-qr" href={qr} target="_blank" rel="noreferrer" title="Open the QR code to print it">
        <img src={qr} alt={`QR code for ${own ? e.link : me.public_url}`} onError={() => setOwn(false)} />
        <span className="qr-cap hand" aria-hidden>
          Scan to find your photos
        </span>
      </a>
      <div className="share-tx">
        <b className="share-title">Share with students</b>
        <p className="muted small mt-0.5 mb-2">{own ? 'They scan the QR or open the link, then tap Find my photos.' : 'The QR opens the list of all events; the link opens this event.'}</p>
        <div className="linkbox">
          <a href={`/e/${e.slug}`} target="_blank" rel="noreferrer">
            {e.link}
          </a>
          <Copy text={e.link} label="Copy link" />
        </div>
        <div className="mt-3">
          <Toggle
            label="Open to students"
            checked={live}
            disabled={shut}
            onChange={(on) => void patch({ status: on ? 'live' : 'draft' })}
            hint={shut ? `This event is ${e.status}. Change it under OneDrive & settings.` : live ? 'Students can find their photos and see the album.' : 'Off: students see "Photos coming soon". Switch on when the photos are in.'}
          />
        </div>
      </div>
    </section>
  );
}

/** The one thing to do next on this event, when it is not the tab already open: approve what waits, or add the first photos. */
function NextStep({ e, tab, go }: { e: AdminEvent; tab: EventTab; go: (tab: EventTab) => void }) {
  const c = e.counts;
  const open = e.status === 'draft' || e.status === 'live';
  const step =
    c.review > 0 && tab !== 'waiting'
      ? { text: `${c.review} ${c.review === 1 ? 'photo or video from a student waits' : 'photos and videos from students wait'} for your approval.`, label: 'Review them', icon: 'check' as const, to: 'waiting' as const }
      : c.total === 0 && open && tab !== 'add'
        ? { text: 'No photos yet. Add the photos and videos of the event first.', label: 'Add photos & videos', icon: 'upload' as const, to: 'add' as const }
        : null;
  if (!step) return null;
  return (
    <div className="slip nextstep">
      <span className="note-hand">next:</span>
      <p className="m-0 flex-1 min-w-[200px]">{step.text}</p>
      <button type="button" className="btn primary" onClick={() => go(step.to)}>
        <Icon name={step.icon} size={18} /> {step.label}
      </button>
    </div>
  );
}

/** How far the photos of the event have been read: a paper card with the red ring. */
function ReadProgress({ e }: { e: AdminEvent }) {
  const c = e.counts;
  const done = c.total - c.waiting - c.processing - c.failed - c.skipped;
  const pct = c.total ? Math.round((Math.max(0, done) / c.total) * 100) : 0;
  const busy = e.syncing || c.waiting + c.processing > 0;
  return (
    <div className="progress navy">
      <Ring pct={pct} arc="var(--red)" track="var(--paper-2)" />
      <div className="min-w-0">
        <b className="block text-[17px]">{e.syncing ? 'Syncing…' : busy ? 'Reading photos…' : c.total ? 'Photos read' : 'No photos yet'}</b>
        <div className="soft small">
          {Math.max(0, done)} of {c.total} files read · {c.faces} faces found
        </div>
        <div className="soft small">Last sync: {time(e.last_sync_at)}</div>
      </div>
    </div>
  );
}

/** Who can see the event: Coming soon, Open, Closed, Archived. */
function StateChoice({ e, patch }: { e: AdminEvent; patch: (b: unknown) => Promise<boolean> }) {
  // Archiving deletes the event's face data at once, so it takes two taps.
  const [arm, setArm] = useState(false);
  const choose = (key: AdminEvent['status']) => {
    if (key === 'archived' && e.status !== 'archived' && !arm) return setArm(true);
    setArm(false);
    if (key !== e.status) void patch({ status: key });
  };
  return (
    <Section icon="bolt" title="Who can see this event" edge="navy">
      {STATES.map((s) => (
        <label key={s.key} className={`choice ${e.status === s.key ? 'on' : ''}`}>
          <input type="radio" name="state" checked={e.status === s.key} onChange={() => choose(s.key)} />
          <span>
            <b>{s.label}</b>
            <span className="muted small block">{s.what}</span>
            {s.key === 'archived' && arm && (
              <span className="err block mt-1 font-semibold" role="status">
                Tap Archived again to confirm. Find my photos stops for this event: its face data and every phone's saved results are deleted.
              </span>
            )}
          </span>
        </label>
      ))}
    </Section>
  );
}

function SyncTab({ e, patch, sync, reload }: TabProps) {
  const qc = useQueryClient();
  const folders = useApi<{ folders: { id: string; name: string; used_by: string | null }[] }>('/admin/onedrive/folders');
  const readFolders = () => void qc.invalidateQueries({ queryKey: apiKey('/admin/onedrive/folders') });
  // Failed and skipped files together; read again when their counts move (see EventPage).
  const problems = useQuery({
    queryKey: apiKey(`/admin/events/${e.id}/media?filter=failed+skipped&limit=100`),
    queryFn: async () => [...(await api<{ media: any[] }>(`/admin/events/${e.id}/media?filter=failed&limit=100`)).media, ...(await api<{ media: any[] }>(`/admin/events/${e.id}/media?filter=skipped&limit=100`)).media],
  });
  const [pick, setPick] = useState(e.folder?.id ?? '');
  const [newName, setNewName] = useState('');
  // The test always ends with steps to show: a failed call is its one red step.
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; steps: { step: string; ok: boolean; detail: string }[] }>('/admin/onedrive/test', { json: { folder_id: e.folder?.id ?? null } }).catch((err) => ({
        ok: false,
        steps: [{ step: 'Connection test', ok: false, detail: (err as Error).message }],
      })),
  });

  const shut = e.status === 'closed' || e.status === 'archived';
  const [sure, setSure] = useState(false);
  // Another folder means another set of photos: ask twice once the album has photos.
  const swaps = !!e.folder && pick !== e.folder.id && e.counts.total > 0;
  const link = async () => {
    if (swaps && !sure) return setSure(true);
    setSure(false);
    if (await patch({ onedrive_folder_id: pick || null })) if (pick && !shut) await sync();
  };
  const create = async (ev: FormEvent) => {
    ev.preventDefault();
    const { folder } = await api<{ folder: { id: string } }>('/admin/onedrive/folders', { json: { name: newName } });
    setNewName('');
    setPick(folder.id);
    readFolders();
  };
  const retry = async () => {
    await api(`/admin/events/${e.id}/retry`, { method: 'POST' });
    reload();
  };
  const [again, setAgain] = useState<'idle' | 'ask'>('idle');
  const readAgain = useMutation({ mutationFn: () => api(`/admin/events/${e.id}/reread`, { method: 'POST' }), onSuccess: reload });
  const reread = () => {
    if (again !== 'ask') return setAgain('ask');
    setAgain('idle');
    readAgain.mutate();
  };

  const duplicates = useMutation({ mutationFn: () => api<{ copies: number }>(`/admin/events/${e.id}/duplicates`, { method: 'POST' }), onSuccess: reload });
  const copies = duplicates.data?.copies;
  const dupNote = duplicates.error
    ? `Could not look for duplicates: ${duplicates.error.message}`
    : copies === undefined
      ? null
      : copies
        ? `${copies} duplicate${copies === 1 ? '' : 's'} found. Only the best photo of each is shown; the others are under Photos › Duplicates.`
        : 'No duplicates found.';

  const arrived = (useLocation().state ?? {}) as { folderError?: string | null; fresh?: boolean };
  const make = useMutation({
    mutationFn: () => api(`/admin/events/${e.id}/folder`, { method: 'POST' }),
    onSuccess: () => {
      reload();
      readFolders();
    },
  });
  // A folder that could not be made with the new event shows here until the next try.
  const makeError = make.isIdle ? arrived.folderError ?? null : make.error?.message ?? null;

  return (
    <>
      <Section icon="folder" title="The event's folder in OneDrive" edge="navy">
        {!e.folder ? (
          <div className="form-section mt-0!">
            <b>This event has no folder yet</b>
            {makeError && <Note bad>{makeError}</Note>}
            <p className="muted small">The folder is made inside Event Photos in OneDrive, named after the event.</p>
            <button className="btn primary" onClick={() => make.mutate()} disabled={make.isPending || shut}>
              <Icon name="folder" size={18} /> {make.isPending ? 'Making the folder…' : 'Make the folder'}
            </button>
          </div>
        ) : (
          <>
            <div className="kv">
              <div>
                <span>Folder</span>
                <b>Event Photos › {e.folder.name}</b>
              </div>
              <div>
                <span>Last sync</span>
                <b>{time(e.last_sync_at)}</b>
              </div>
              <div>
                <span>Photos in the album</span>
                <b>{e.counts.shown}</b>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 items-center">
              <button className="btn primary" onClick={sync} disabled={e.syncing || shut}>
                <Icon name="refresh" size={18} /> {e.syncing ? 'Syncing…' : 'Sync now'}
              </button>
              <span className="muted small">Photos you put in this folder in OneDrive show up here. The app also checks every 10 minutes.</span>
            </div>
          </>
        )}
        {shut && <Note kind="warn">A closed event is not synced: its album stays as it is. Set it to Open to sync again.</Note>}
        {e.sync_error && <Note bad>{e.sync_error}</Note>}
        {e.folder && (e.syncing || e.counts.waiting + e.counts.processing > 0) && (
          <div className="mt-3">
            <ReadProgress e={e} />
          </div>
        )}
        {(problems.data?.length ?? 0) > 0 && (
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
              <h3 className="m-0">Files that could not be read</h3>
              {e.counts.failed > 0 && (
                <button className="btn sm soft" onClick={retry}>
                  <Icon name="refresh" size={16} /> Try them again
                </button>
              )}
            </div>
            <div className="tblwrap">
              <table>
                <tbody>
                  {problems.data!.map((m) => (
                    <tr key={m.id}>
                      <td className="break-all">{m.name}</td>
                      <td className="muted">{m.status_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <details className="more">
          <summary>Use a different folder</summary>
          <div className="in">
            <Load query={folders}>
              <div className="row">
                <div className="min-w-[240px]!">
                  <label htmlFor="folder" className="mt-0">
                    Pick a folder in Event Photos
                  </label>
                  <select
                    id="folder"
                    value={pick}
                    onChange={(ev) => {
                      setPick(ev.target.value);
                      setSure(false);
                    }}
                  >
                    <option value="">No folder</option>
                    {e.folder && folders.data && !folders.data.folders.some((f) => f.id === e.folder!.id) && <option value={e.folder.id}>{e.folder.name} (no longer in OneDrive)</option>}
                    {folders.data?.folders.map((f) => (
                      <option key={f.id} value={f.id} disabled={!!f.used_by && f.id !== e.folder?.id}>
                        {f.name}
                        {f.used_by && f.id !== e.folder?.id ? ` (used by ${f.used_by})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn primary flex-none!" onClick={link} disabled={pick === (e.folder?.id ?? '')}>
                  <Icon name="check" size={18} /> {swaps && sure ? 'Tap again to change the folder' : 'Use this folder'}
                </button>
              </div>
              {swaps && <Note kind="warn">The album follows the folder. Photos that are not in the new folder leave the album at the next sync.</Note>}
              <form onSubmit={create} className="row mt-1">
                <div className="min-w-[240px]!">
                  <label htmlFor="newfolder">Or make a new folder</label>
                  <input id="newfolder" value={newName} onChange={(ev) => setNewName(ev.target.value)} placeholder={`${e.starts_on ?? '2026-11-20'} ${e.title}`} />
                </div>
                <button className="btn soft flex-none!" disabled={!newName.trim()}>
                  <Icon name="plus" size={18} /> Create folder
                </button>
              </form>
            </Load>
          </div>
        </details>

        <details className="more">
          <summary>Advanced: duplicates, read every photo again, connection test</summary>
          <div className="in">
            <p className="muted small mt-0">
              <b className="text-ink">Look for duplicates again</b> finds the same shot taken more than once (burst shots, the same group photo twice) and shows only the best one. New photos are checked by themselves; this is for photos that were here before.
            </p>
            <button className="btn soft" onClick={() => duplicates.mutate()} disabled={duplicates.isPending || e.syncing}>
              <Icon name="copy" size={18} /> {duplicates.isPending ? 'Looking…' : 'Look for duplicates again'}
            </button>
            {dupNote && <Note kind={dupNote.startsWith('Could') ? 'warn' : 'ok'}>{dupNote}</Note>}
            <hr className="my-5 border-line" />
            <p className="muted small mt-0">
              <b className="text-ink">Read every photo again</b> makes fresh face data for every shown photo, from the originals in OneDrive. Use it after bringing an archived event back.
            </p>
            <button className={`btn ${again === 'ask' ? 'dark' : 'soft'}`} onClick={reread} disabled={!e.folder || e.syncing}>
              <Icon name="refresh" size={18} /> {again === 'ask' ? 'Tap again to start' : 'Read every photo again'}
            </button>
            {readAgain.error && <Note bad>{readAgain.error.message}</Note>}
            <p className="muted small mt-5">
              <b className="text-ink">Connection test</b> lists the folder, downloads one photo, then saves a small test file and removes it.
            </p>
            <button className="btn soft" onClick={() => test.mutate()} disabled={test.isPending}>
              <Icon name="wifi" size={18} /> {test.isPending ? 'Testing…' : 'Run the test'}
            </button>
            {test.data && <Steps steps={test.data.steps} />}
          </div>
        </details>
      </Section>
    </>
  );
}

const MAX_PHOTO_MB = 60;
const MAX_VIDEO_GB = 2;
/** Answers that stop the whole batch: nothing after them can work either. */
const STOPS = ['reconnect', 'not_connected', 'folder_gone', 'closed', 'archived', 'unauthorized', 'not_signed_in', 'disk_full'];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface UploadRun {
  total: number;
  done: number;
  added: number;
  skipped: number;
  failed: number;
  stopped: string | null;
  finished: boolean;
}

/** What an organiser's file is, before it is sent: a reason it cannot go, or null. */
function refuse(f: File): string | null {
  const video = f.type.startsWith('video/');
  if (!video && !f.type.startsWith('image/')) return 'Not a photo or a video.';
  if (video && f.size > MAX_VIDEO_GB * 1024 ** 3) return `Larger than ${MAX_VIDEO_GB} GB.`;
  if (!video && f.size > MAX_PHOTO_MB * 1024 ** 2) return `Larger than ${MAX_PHOTO_MB} MB.`;
  return null;
}

/**
 * Organisers add photos and videos from the browser. Each file goes into the event's OneDrive folder, three at a time,
 * with its own progress; a moment's trouble with OneDrive or the connection is tried again twice before it counts as failed.
 */
function AddMedia({ e, reload }: { e: AdminEvent; reload: () => void }) {
  const [run, setRun] = useState<UploadRun | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const working = !!run && !run.finished;
  const open = e.status === 'draft' || e.status === 'live';
  const arrived = (useLocation().state ?? {}) as { folderError?: string | null; fresh?: boolean };

  // Leaving the page would stop the files still waiting to be sent.
  useEffect(() => {
    if (!working) return;
    const stay = (ev: BeforeUnloadEvent) => ev.preventDefault();
    window.addEventListener('beforeunload', stay);
    return () => window.removeEventListener('beforeunload', stay);
  }, [working]);

  const send = async (files: File[]) => {
    if (!files.length) return;
    const list: UploadItem[] = files.map((f, i) => ({ key: Date.now() + i, name: f.name, bytes: f.size, video: f.type.startsWith('video/'), state: 'waiting', sent: 0 }));
    const r: UploadRun = { total: files.length, done: 0, added: 0, skipped: 0, failed: 0, stopped: null, finished: false };
    // Progress events come fast: the screen is redrawn at most every 150 ms.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const draw = () => {
      timer = null;
      setItems(list.map((x) => ({ ...x })));
      setRun({ ...r });
    };
    const show = (now = false) => {
      if (now) {
        if (timer) clearTimeout(timer);
        return draw();
      }
      timer ??= setTimeout(draw, 150);
    };
    show(true);
    const sendOne = async (f: File, it: UploadItem): Promise<'added' | 'skipped'> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await uploadFile<{ result: string }>(`/admin/events/${e.id}/photos`, f, {
            headers: { 'content-type': f.type, 'x-file-name': encodeURIComponent(f.name) },
            onProgress: (sent) => {
              it.sent = sent;
              show();
            },
          });
          return out?.result === 'added' ? 'added' : 'skipped';
        } catch (err) {
          const ae = err as ApiError;
          const passing = ae.code === 'offline' || ae.code === 'drive_down' || ae.status === 502 || ae.status === 504;
          if (!passing || attempt >= 2) throw ae;
          it.sent = 0;
          await wait(1500 * (attempt + 1));
        }
      }
    };
    let next = 0;
    const worker = async () => {
      while (!r.stopped && next < files.length) {
        const i = next++;
        const f = files[i];
        const it = list[i];
        const no = refuse(f);
        if (no) Object.assign(it, { state: 'failed', why: no });
        else {
          it.state = 'sending';
          show(true);
          try {
            const out = await sendOne(f, it);
            it.state = out === 'added' ? 'added' : 'copy';
            if (out === 'added') r.added++;
            else r.skipped++;
          } catch (err) {
            const ae = err as ApiError;
            Object.assign(it, { state: 'failed', why: ae.message });
            if (STOPS.includes(ae.code) || ae.status === 401) r.stopped = ae.message;
          }
        }
        if (it.state === 'failed') r.failed++;
        r.done++;
        show(true);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    r.finished = true;
    show(true);
    reload();
  };

  const bytes = items.reduce((n, x) => n + x.bytes, 0);
  const sent = items.reduce((n, x) => n + (x.state === 'sending' ? Math.min(x.sent, x.bytes) : x.state === 'waiting' ? 0 : x.bytes), 0);
  const pct = bytes ? Math.round((sent / bytes) * 100) : 0;
  return (
    <div className="max-w-[880px]">
      {arrived.fresh && (
        <Note kind="ok" title="Event created">
          Now add its photos and videos. Then switch on Open to students above.
        </Note>
      )}
      {arrived.folderError && (
        <Note bad title="The OneDrive folder could not be made">
          {arrived.folderError} Try again under OneDrive & settings.
        </Note>
      )}
      {!open ? (
        <Note kind="warn">Photos and videos can be added while the event is Coming soon or Open.</Note>
      ) : (
        <DropZone
          title={working ? 'Sending…' : run?.finished ? 'Add more photos and videos' : 'Drop photos and videos here, or choose them'}
          hint={`As many as you like. Photos up to ${MAX_PHOTO_MB} MB, videos up to ${MAX_VIDEO_GB} GB. Copies are skipped.`}
          accept="image/*,video/*"
          disabled={working}
          onFiles={send}
        />
      )}
      {run && (
        <div className={`notice ${!run.finished ? 'info' : run.stopped || run.failed ? 'bad' : 'ok'} mt-3`} role="status" aria-live="polite">
          <Icon name={run.finished ? (run.stopped || run.failed ? 'alert' : 'check') : 'upload'} size={20} />
          <div>
            <b>
              {!run.finished
                ? `Sending ${run.done} of ${run.total}… (${pct}%)`
                : `${run.added} added${run.skipped ? `, ${run.skipped} skipped as copies` : ''}${run.failed ? `, ${run.failed} not added` : ''}${run.stopped ? `, ${run.total - run.done} not sent` : ''}.`}
            </b>
            {!run.finished && (
              <div className="bar">
                <div style={{ width: `${pct}%` }} />
              </div>
            )}
            {run.stopped && <p className="mt-1 mb-0">Stopped: {run.stopped}</p>}
            {run.finished && run.added > 0 && <p className="mt-1 mb-0">Faces are found in the background; the album fills in over the next minute.</p>}
          </div>
        </div>
      )}
      {items.length > 0 && <UploadList items={items} />}
      {reading(e) && (
        <div className="mt-3">
          <ReadProgress e={e} />
        </div>
      )}
      <p className="muted small mt-4">
        <Icon name="folder" size={16} className="inline-block align-[-3px] mr-1" /> Saved into {e.folder ? <b className="text-ink">Event Photos › {e.folder.name}</b> : "the event's OneDrive folder (made now if it has none)"}. You can also put files straight into that folder in OneDrive: the app picks them up every 10 minutes.
      </p>
    </div>
  );
}

type MediaPage = { total?: number; media: AdminMedia[] };
/**
 * An event's photo list, page by page (`path` has the filter; each page adds offset and limit). The next page starts
 * after what is on screen, so photos approved or hidden meanwhile do not leave a gap.
 */
function useMediaPages(path: string, size: number, placeholder?: boolean) {
  const q = useInfiniteQuery({
    queryKey: apiKey(path),
    queryFn: ({ pageParam }) => api<MediaPage>(`${path}&offset=${pageParam}&limit=${size}`),
    initialPageParam: 0,
    getNextPageParam: (last: MediaPage, pages: MediaPage[]) => {
      const have = pages.reduce((n, p) => n + p.media.length, 0);
      // Without a total from the server: there may be more while a full page came back.
      return (typeof last.total === 'number' ? last.media.length > 0 && have < last.total : last.media.length >= size) ? have : undefined;
    },
    ...(placeholder ? { placeholderData: keepPreviousData } : {}),
  });
  const seen = new Set<string>();
  // A photo that moved up a page between two loads is shown once.
  const media = (q.data?.pages ?? []).flatMap((p) => p.media).filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  return { q, media, total: q.data?.pages.at(-1)?.total };
}

/** Show more, with how many of the total are on screen. */
function More({ q, shown, total }: { q: ReturnType<typeof useMediaPages>['q']; shown: number; total?: number }) {
  if (!q.hasNextPage) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 mt-5">
      <button className="btn soft" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
        {q.isFetchingNextPage ? 'Loading…' : 'Show more'}
      </button>
      {typeof total === 'number' && (
        <span className="muted small">
          {shown} of {total}
        </span>
      )}
    </div>
  );
}

/** What students sent: approve or reject each one, or all at once. */
function Waiting({ e, reload }: { e: AdminEvent; reload: () => void }) {
  const qc = useQueryClient();
  const path = `/admin/events/${e.id}/media?filter=review`;
  const { q: list, media, total = media.length } = useMediaPages(path, 200);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const act = async (ids: string[], action: 'approve' | 'reject') => {
    setError(null);
    try {
      await api('/admin/media', { method: 'PATCH', json: { ids, action } });
      // It leaves the list at once; the counts follow.
      qc.setQueryData<InfiniteData<MediaPage, number>>(apiKey(path), (d) =>
        d ? { ...d, pages: d.pages.map((p) => ({ total: p.total === undefined ? undefined : p.total - ids.length, media: p.media.filter((m) => !ids.includes(m.id)) })) } : d,
      );
      setOpen(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const approveAll = async () => {
    setError(null);
    try {
      await api(`/admin/events/${e.id}/approve-all`, { method: 'POST' });
      qc.setQueryData<InfiniteData<MediaPage, number>>(apiKey(path), { pages: [{ total: 0, media: [] }], pageParams: [0] });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const onClose = useCallback(() => setOpen(null), []);
  return (
    <Load query={list}>
      {error && <Note bad>{error}</Note>}
      {media.length === 0 ? (
        <div className="card">
          <Empty icon="check" title="Nothing is waiting">
            Photos and videos that students add show up here. They appear in the album after you approve them.
          </Empty>
        </div>
      ) : (
        <>
          <div className="waitbar">
            <p className="muted m-0 flex-1 min-w-[200px]">
              <b className="text-ink">{total} waiting.</b> Look at each one, or approve them all. They appear in the album after you approve them.
            </p>
            <button className="btn primary" onClick={approveAll}>
              <Icon name="check" size={18} /> Approve all ({total})
            </button>
          </div>
          <div className="sheet">
            <div className="sheet-head" aria-hidden>
              <span>From students</span>
              <span className="muted">{total} {total === 1 ? 'frame' : 'frames'}</span>
            </div>
            <ul className="tiles waitgrid list-none p-0 m-0">
              {media.map((m, i) => (
                <li key={m.id} className="wait">
                  <button className="tile" onClick={() => setOpen(i)} aria-label={`Open ${m.type === 'video' ? 'video' : 'photo'} ${m.name ?? i + 1}`}>
                    {m.thumb ? <AlbumImg src={m.thumb} alt="" loading="lazy" /> : <span className="state">{m.status}</span>}
                    <span className="fno" aria-hidden>
                      {frameNo(i)}
                    </span>
                    {m.type === 'video' && <VideoBadge ms={m.duration_ms} />}
                    <span className="tag">by {m.uploader_name ?? 'a student'}</span>
                  </button>
                  <div className="acts">
                    <button className="btn sm success" onClick={() => act([m.id], 'approve')} aria-label={`Approve ${m.name ?? `item ${i + 1}`}`}>
                      <Icon name="check" size={16} /> Approve
                    </button>
                    <button className="btn sm danger" onClick={() => act([m.id], 'reject')} aria-label={`Reject ${m.name ?? `item ${i + 1}`}`}>
                      <Icon name="xmark" size={16} /> Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <More q={list} shown={media.length} total={total} />
        </>
      )}
      {open !== null && media[open] && (
        <Viewer
          photos={media.map(asPhoto)}
          index={open}
          onIndex={setOpen}
          onClose={onClose}
          canSave
          original={(p) => `/api/admin/media/${p.id}/original`}
          caption={() => `by ${media[open].uploader_name ?? 'a student'}`}
          actions={(p) => (
            <>
              <button className="btn sm light" onClick={() => act([p.id], 'approve')}>
                <Icon name="check" size={18} /> Approve
              </button>
              <button className="btn sm" onClick={() => act([p.id], 'reject')}>
                <Icon name="xmark" size={18} /> Reject
              </button>
            </>
          )}
        />
      )}
    </Load>
  );
}

const FILTERS: [string, string][] = [
  ['shown', 'In the album'],
  ['duplicates', 'Duplicates'],
  ['hidden', 'Hidden'],
  ['nofaces', 'No faces'],
  ['failed', 'Failed'],
  ['skipped', 'Skipped'],
  ['lost', 'Cannot be shown'],
  ['all', 'All'],
];

const FILTER_COUNT: Record<string, (c: AdminEvent['counts']) => number> = {
  duplicates: (c) => c.copies,
  hidden: (c) => c.hidden,
  nofaces: (c) => c.no_faces,
  failed: (c) => c.failed,
  skipped: (c) => c.skipped,
  lost: (c) => c.lost ?? 0,
};

function Photos({ e, reload, patch }: { e: AdminEvent; reload: () => void; patch: (b: unknown) => Promise<boolean> }) {
  const qc = useQueryClient();
  // A link may open a filter (an alert's "Open the Media manager": ?filter=lost).
  const [params] = useSearchParams();
  const [filter, setFilter] = useState(() => (FILTERS.some(([k]) => k === params.get('filter')) ? params.get('filter')! : 'shown'));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const pathOf = (k: string) => `/admin/events/${e.id}/media?filter=${k}`;
  // The last list stays on screen while another filter loads. It is read again when the counters move (see EventPage).
  const { q: list, media, total } = useMediaPages(pathOf(filter), 60, true);
  useEffect(() => setPicked(new Set()), [filter]);
  /** Another filter starts again from its first page. */
  const choose = (k: string) => {
    if (k === filter) return;
    qc.removeQueries({ queryKey: apiKey(pathOf(k)), exact: true });
    setFilter(k);
  };

  const act = async (action: string, ids = [...picked]) => {
    if (!ids.length) return;
    await api('/admin/media', { method: 'PATCH', json: { ids, action } });
    setPicked(new Set());
    reload();
  };
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const n = picked.size;
  const filters = FILTERS.filter(([k]) => k === filter || ['shown', 'all'].includes(k) || (FILTER_COUNT[k]?.(e.counts) ?? 0) > 0);

  return (
    <div>
      {filters.length > 2 && <Chips label="Show" value={filter} onChange={choose} items={filters.map(([k, label]) => ({ key: k, label, count: FILTER_COUNT[k]?.(e.counts) }))} />}
      <div className="selbar">
        {n > 0 ? (
          <>
            <span className="pill stamp navy">{n} selected</span>
            {filter === 'duplicates' && (
              <button className="btn sm primary" onClick={() => act('show_anyway')}>
                Show anyway
              </button>
            )}
            {filter === 'lost' && (
              <button className="btn sm primary" onClick={() => act('rebuild')}>
                Try again
              </button>
            )}
            {filter === 'hidden' ? (
              <button className="btn sm primary" onClick={() => act('unhide')}>
                Unhide
              </button>
            ) : (
              ['shown', 'nofaces', 'all'].includes(filter) && (
                <button className="btn sm danger" onClick={() => act('hide')}>
                  <Icon name="eyeoff" size={16} /> Hide
                </button>
              )
            )}
            {n === 1 && filter === 'shown' && (
              <button className="btn sm soft" onClick={() => patch({ cover_media_id: [...picked][0] }).then(() => setPicked(new Set()))}>
                <Icon name="image" size={16} /> Use as cover
              </button>
            )}
            <button className="btn sm" onClick={() => setPicked(new Set())}>
              Clear
            </button>
          </>
        ) : (
          <>
            <span className="muted small">Tap photos or videos to pick them, then hide them or use one as the cover. Deleting is done in OneDrive.</span>
            {e.cover_media_id && (
              <button className="btn sm" onClick={() => void patch({ cover_media_id: null })} title="Stop using the chosen photo: the event picks its own cover again">
                <Icon name="image" size={16} /> Automatic cover
              </button>
            )}
          </>
        )}
      </div>
      <Load query={list}>
        {list.data && media.length === 0 && (
          <div className="card">
            <Empty title="Nothing here">{filter === 'shown' ? 'Add photos and videos on the first tab.' : null}</Empty>
          </div>
        )}
        {media.length > 0 && (
          <div className="sheet">
            <div className="sheet-head" aria-hidden>
              <span>Contact sheet</span>
              <span className="muted">
                {total ?? media.length} {(total ?? media.length) === 1 ? 'frame' : 'frames'}
              </span>
            </div>
            <div className="tiles">
              {media.map((m, i) => (
                <button key={m.id} className={`tile ${m.hidden ? 'is-hidden' : ''}`} aria-pressed={picked.has(m.id)} onClick={() => toggle(m.id)} title={m.name ?? ''}>
                  {m.thumb ? <AlbumImg src={m.thumb} alt="" loading="lazy" /> : <span className="state">{m.status}</span>}
                  {/* picked: circled in red grease pencil, as on a real contact sheet */}
                  {picked.has(m.id) && <PencilCircle draw />}
                  {m.hidden && (
                    <span className="hid" aria-hidden>
                      Hidden
                    </span>
                  )}
                  <span className="tick" aria-hidden>
                    {picked.has(m.id) && <Icon name="check" size={14} />}
                  </span>
                  <span className="fno" aria-hidden>
                    {frameNo(i)}
                  </span>
                  {m.type === 'video' ? (
                    <VideoBadge ms={m.duration_ms} />
                  ) : (
                    m.face_count > 0 && (
                      <span className="faces">
                        <Icon name="user" size={12} />
                        {m.face_count}
                      </span>
                    )
                  )}
                  <span className="tag">
                    {m.copies_lost
                      ? `cannot be shown: ${m.copies_error ?? 'its original is gone'}`
                      : m.duplicate_of
                        ? `copy of ${m.copy_of_name ?? 'another photo'}`
                        : m.status_reason || (m.source === 'crowd' ? `by ${m.uploader_name ?? 'a student'}` : m.name)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <More q={list} shown={media.length} total={total} />
      </Load>
    </div>
  );
}

function EventSettings({ e, patch }: { e: AdminEvent; patch: (b: unknown) => Promise<boolean> }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<EventForm>({
    title: e.title,
    starts_on: e.starts_on ?? '',
    ends_on: e.ends_on ?? '',
    campus_id: e.campus?.id ?? '',
    venue: e.venue ?? '',
    passcode: '',
    allow_download: e.allow_download,
    face_enabled: e.face_enabled,
    listed: e.listed,
    crowd_uploads: e.crowd_uploads,
    auto_approve: e.auto_approve,
    improve_photos: e.improve_photos ?? true,
    close_on: e.close_on ?? '',
    face_days: e.face_days == null ? '' : String(e.face_days),
  });
  const boss = useContext(MeCtx)!.user.role === 'super_admin';
  const [saved, setSaved] = useState(false);
  const [wrong, setWrong] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    setWrong(datesWrong(f));
    if (datesWrong(f)) return;
    const { passcode, ...rest } = formBody(f);
    const ok = await patch({ ...rest, ...(passcode ? { passcode } : {}) });
    setSaved(ok);
    if (ok) setF((x) => ({ ...x, passcode: '' }));
  };
  const remove = async () => {
    if (!ask) return setAsk(true);
    setDeleteError(null);
    try {
      await api(`/admin/events/${e.id}`, { method: 'DELETE' });
    } catch (err) {
      setAsk(false);
      return setDeleteError((err as Error).message);
    }
    void qc.invalidateQueries({ queryKey: apiKey('/admin/events') });
    nav('/admin');
  };
  return (
    <>
      <form onSubmit={save}>
        <Section icon="edit" title="Event details" edge="navy">
          <EventFields f={f} set={(p) => (setSaved(false), setWrong(null), setF((x) => ({ ...x, ...p })))} hasPasscode={e.has_passcode} faceDeletedAt={e.face_deleted_at} />
          {wrong && <Note bad>{wrong}</Note>}
          <div className="flex flex-wrap gap-2 items-center mt-5">
            <button className="btn primary">
              <Icon name="check" size={18} /> Save changes
            </button>
            {e.has_passcode && (
              <button type="button" className="btn" onClick={() => patch({ passcode: null })}>
                Remove the passcode
              </button>
            )}
            {saved && <span className="pill green">Saved</span>}
          </div>
        </Section>
      </form>
      <StateChoice e={e} patch={patch} />
      <Section icon="trash" colour="red" title="Delete this event" edge="red">
        <p className="muted small mt-0">Removes the event, its copies in OneDrive's app folder and its face data from this app. The originals stay in OneDrive.</p>
        {boss ? (
          <button type="button" className={`btn danger ${ask ? 'solid' : ''}`} onClick={remove}>
            <Icon name="trash" size={18} /> {ask ? 'Tap again to delete the event' : 'Delete the event'}
          </button>
        ) : (
          <p className="small mb-0">Only a super admin can delete an event. You can archive it.</p>
        )}
        {deleteError && <Note bad>{deleteError}</Note>}
      </Section>
    </>
  );
}

// ---- B8: requests ---------------------------------------------------------------------------
/** A report of one photo, or a student's request to be removed from the photos they are in (GET /admin/requests). */
interface AdminRequest {
  id: string;
  kind?: 'report' | 'removal' | string;
  reason: string | null;
  created_at: string;
  media_id: string | null;
  event_title: string;
  thumb: string | null;
  web: string | null;
  /** How many photos it lists, and the photos (older servers send neither). */
  count?: number;
  photos?: { id: string; type?: 'photo' | 'video'; thumb: string | null; web: string | null; video?: string | null; hidden: boolean }[];
}

function Requests() {
  const qc = useQueryClient();
  const requests = useApi<{ requests: AdminRequest[] }>('/admin/requests');
  const data = requests.data;
  const [error, setError] = useState<string | null>(null);
  // The requests being answered: their buttons stay off until the list has been read again, so a second tap cannot send twice.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const answer = async (id: string, status: 'approved' | 'declined') => {
    setError(null);
    setBusy((b) => new Set(b).add(id));
    try {
      await api(`/admin/requests/${id}`, { method: 'PATCH', json: { status } });
      // Also updates the count in the top bar, the events' counts and every open event's lists of photos (hidden ones go).
      void qc.invalidateQueries(under('/admin/events'));
      await qc.invalidateQueries({ queryKey: apiKey('/admin/requests') });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(id);
        return n;
      });
    }
  };
  return (
    <>
      <p className="eyebrow">Reports from students</p>
      <Head title="Requests">{data && data.requests.length > 0 && <span className="pill stamp red">{data.requests.length} open</span>}</Head>
      <p className="muted mb-4">Photos that students reported, and students who asked to be removed. Hiding takes the photos out of the album and out of everyone's results at once.</p>
      {error && <Note bad>{error}</Note>}
      <Load query={requests}>
        {data?.requests.length === 0 && (
          <div className="card">
            <Empty icon="check" title="No open requests">
              Reports from students show up here.
            </Empty>
          </div>
        )}
        <div className="cards">
          {data?.requests.map((q) =>
            q.kind === 'removal' ? (
              <RemovalItem key={q.id} q={q} busy={busy.has(q.id)} answer={answer} />
            ) : (
              <div key={q.id} className="item red still">
                {q.thumb && (
                  <a href={piped(q.web ?? q.thumb)} target="_blank" rel="noreferrer" className="req-frame on-dark">
                    <AlbumImg src={q.thumb} alt="The reported photo" />
                  </a>
                )}
                <div className="item-top">
                  <span className="pill stamp red">Reported</span>
                  <span className="sp" />
                  <span className="muted small">{time(q.created_at)}</span>
                </div>
                <div className="item-title">{q.event_title}</div>
                <div className="quote">{q.reason || 'No reason given.'}</div>
                <div className="item-foot">
                  <button className="btn sm danger solid" onClick={() => answer(q.id, 'approved')} disabled={busy.has(q.id)}>
                    <Icon name="eyeoff" size={16} /> Hide photo
                  </button>
                  <button className="btn sm" onClick={() => answer(q.id, 'declined')} disabled={busy.has(q.id)}>
                    Keep photo
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      </Load>
    </>
  );
}

/** "Remove me": the photos a student was found in, as a strip of film, and one tap to take them all out of the album. */
function RemovalItem({ q, busy, answer }: { q: AdminRequest; busy: boolean; answer: (id: string, status: 'approved' | 'declined') => void }) {
  const photos = q.photos ?? [];
  const n = q.count ?? photos.length;
  return (
    <div className="item red still" aria-label={`Remove me, ${q.event_title}`} role="group">
      {photos.length > 0 && (
        <ul className="req-strip on-dark" aria-label="The photos">
          {photos.map((p, i) => (
            <li key={p.id}>
              <a href={p.web ?? p.thumb ? piped((p.web ?? p.thumb)!) : undefined} target="_blank" rel="noreferrer" aria-label={`Open ${p.type === 'video' ? 'video' : 'photo'} ${i + 1}${p.hidden ? ', already hidden' : ''}`} className={p.hidden ? 'is-hidden' : ''}>
                {p.thumb ? <AlbumImg src={p.thumb} alt="" loading="lazy" /> : <span className="blank" />}
                {p.type === 'video' && <VideoBadge />}
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="item-top">
        <span className="pill stamp red">{`Remove me · ${n} ${n === 1 ? 'photo' : 'photos'}`}</span>
        <span className="sp" />
        <span className="muted small">{time(q.created_at)}</span>
      </div>
      <div className="item-title">{q.event_title}</div>
      <p className="m-0 small">A student asked to be removed from these photos.</p>
      <div className="quote">{q.reason || 'No note.'}</div>
      <div className="item-foot">
        <button className="btn sm danger solid" onClick={() => answer(q.id, 'approved')} disabled={busy}>
          <Icon name="eyeoff" size={16} /> Remove from album
        </button>
        <button className="btn sm" onClick={() => answer(q.id, 'declined')} disabled={busy}>
          Keep photos
        </button>
      </div>
    </div>
  );
}

// ---- B7: the one QR --------------------------------------------------------------------------
function ShareKit() {
  const me = useContext(MeCtx)!;
  const { data } = useApi<{ events: AdminEvent[] }>('/admin/events');
  const campuses = useCampuses().data?.campuses;
  return (
    <>
      <p className="eyebrow">For every event</p>
      <Head title="The one QR" />
      <p className="muted mb-2 max-w-[70ch]">One link and one QR for every event, for all time. Print it once: notice boards, ID cards, the college website. Students pick the event after they scan.</p>
      {/* The one permanent QR on a ticket: the code on the stub, the link and its downloads beside it. */}
      <section className="ticket kit-ticket" aria-label="The one QR and link">
        <div className="ticket-qr">
          <img src="/api/admin/qr" alt={`QR code for ${me.public_url}`} />
          <span className="qr-cap hand" aria-hidden>
            Scan to see every event
          </span>
        </div>
        <div className="ticket-tx">
          <span className="ticket-t">The one link</span>
          <span className="ticket-l">{me.public_url}</span>
          <span className="ticket-d">It opens the list of every event and never changes.</span>
          <div className="ticket-a">
            <a className="btn sm primary" href="/api/admin/qr?format=png" download="event-photos-qr.png">
              <Icon name="download" size={16} /> Download PNG
            </a>
            <a className="btn sm ink" href="/api/admin/qr" download="event-photos-qr.svg">
              <Icon name="download" size={16} /> Download SVG
            </a>
            <Copy text={me.public_url} label="Copy link" />
          </div>
        </div>
      </section>
      <Note kind="warn">The QR is only as permanent as this address. Keep it on a domain the college controls.</Note>
      {!!campuses?.length && (
        <Section icon="pin" title="Campus links">
          <p className="muted small mt-0">Print each campus its own QR; it shows only that campus's events.</p>
          <ul className="campus-links" aria-label="Campus links">
            {campuses.map((c) => {
              const link = `${me.public_url}/c/${c.slug}`;
              const qr = `/api/admin/qr?campus=${encodeURIComponent(c.slug)}`;
              return (
                <li key={c.id} className="campus-link">
                  <img src={qr} alt={`QR code for ${link}`} loading="lazy" />
                  <div className="campus-link-tx">
                    <b>{c.name}</b>
                    <span className="campus-link-l">{link}</span>
                    <div className="campus-link-a">
                      <Copy text={link} label="Copy link" />
                      <a className="btn sm primary" href={`${qr}&format=png`} download={`event-photos-${c.slug}-qr.png`} aria-label={`Download PNG of the ${c.name} QR`}>
                        <Icon name="download" size={16} /> Download PNG
                      </a>
                      <a className="btn sm ink" href={qr} download={`event-photos-${c.slug}-qr.svg`} aria-label={`Download SVG of the ${c.name} QR`}>
                        <Icon name="download" size={16} /> Download SVG
                      </a>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      <Section icon="alert" colour="orange" title="The notice for the registration form and a board at the venue">
        <div className="copyrow">
          <span>{NOTICE(me.contact)}</span>
          <Copy text={NOTICE(me.contact)} label="Copy notice" />
        </div>
      </Section>
      <Section icon="send" colour="green" title="A message for each event">
        {data?.events
          .filter((e) => e.status !== 'archived')
          .map((e) => {
            const text = `Photos from ${e.title} are here: ${e.link}\nTake one selfie and get every photo you are in. No login.`;
            return (
              <div key={e.id} className="copyrow">
                <span className="whitespace-pre-line">{text}</span>
                <Copy text={text} label="Copy message" />
              </div>
            );
          })}
      </Section>
    </>
  );
}

/** The event notice of the plan: people in the photos are told before the event how to have one taken down. */
const NOTICE = (contact: string | null) =>
  `Photos from this event will be shared with attendees through a face-matching photo app. To have a photo taken down, tap Report on it in the app or tell ${contact || 'the help desk'}.`;

// ---- B10: settings ----------------------------------------------------------------------------
interface CheckOut {
  ok: boolean;
  steps: { step: string; ok: boolean; warn?: boolean; detail: string }[];
  report: string;
}

/** "Check everything": real files through every call the app makes to the drive. */
function CheckEverything() {
  const check = useMutation({ mutationFn: () => api<CheckOut>('/admin/onedrive/check', { json: {} }) });
  const out = check.data;
  const busy = check.isPending;
  const error = check.error?.message;
  return (
    <div className="form-section">
      <b>Check everything</b>
      <p className="muted small">Saves three small test photos into a test folder, lists, downloads, renames and changes them, then removes the folder. It takes a few seconds.</p>
      <button className="btn soft" onClick={() => check.mutate()} disabled={busy}>
        <Icon name="tasks" size={18} /> {busy ? 'Checking…' : 'Check everything'}
      </button>
      {error && <Note bad>{error}</Note>}
      {out && (
        <>
          <Steps steps={out.steps} />
          <Note bad={!out.ok} kind="ok">
            {out.ok ? 'Everything the app needs works.' : 'It stopped at the first problem. Copy the result and send it to whoever helps you with the app.'}
          </Note>
          <Copy text={out.report} label="Copy the result" />
        </>
      )}
    </div>
  );
}

interface Member {
  id: string;
  email: string;
  role: 'super_admin' | 'organiser';
  created_at: string;
  /** Older servers do not send it. */
  last_sign_in_at?: string | null;
}

/** Organisers and super admins: added, given a new password or role, or removed by a super admin. */
function Team() {
  const me = useContext(MeCtx)!;
  const qc = useQueryClient();
  const team = useApi<{ team: Member[] }>('/admin/team');
  const data = team.data;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Member['role']>('organiser');
  const [note, setNote] = useState<{ bad?: boolean; text: string } | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  /** Runs a change to the team; `fn` may return its own message in place of `done`. */
  const act = async (fn: () => Promise<string | void>, done: string) => {
    try {
      setNote({ text: (await fn()) || done });
      void qc.invalidateQueries({ queryKey: apiKey('/admin/team') });
    } catch (e) {
      setNote({ bad: true, text: (e as Error).message });
    }
  };
  const add = (ev: FormEvent) => {
    ev.preventDefault();
    const who = email;
    void act(async () => {
      const { emailed } = await api<{ emailed?: boolean }>('/admin/team', { json: { email, password, role } });
      setEmail('');
      setPassword('');
      setRole('organiser');
      if (emailed) return `${who} can sign in now. We emailed them how to sign in.`;
    }, `${who} can sign in now. Give them the password yourself.`);
  };
  const supers = data?.team.filter((m) => m.role === 'super_admin').length ?? 0;
  const [steppingDown, setSteppingDown] = useState(false);
  const changeRole = (m: Member) => {
    const to = m.role === 'super_admin' ? 'organiser' : 'super_admin';
    // Making yourself an organiser closes this page to you, so it asks twice.
    if (m.id === me.user.id && !steppingDown) return setSteppingDown(true);
    setSteppingDown(false);
    void act(async () => {
      await api(`/admin/team/${m.id}`, { method: 'PATCH', json: { role: to } });
      // Your own role: the console follows it.
      if (m.id === me.user.id) void qc.invalidateQueries({ queryKey: apiKey('/admin/me') });
    }, `${m.email} is now ${to === 'super_admin' ? 'a super admin' : 'an organiser'}.`);
  };
  const roleButton = (m: Member) => (
    <button className={`btn sm ${m.id === me.user.id && steppingDown ? 'danger solid' : 'soft'}`} onClick={() => changeRole(m)}>
      {m.id === me.user.id && steppingDown ? 'Tap again to make yourself an organiser' : m.role === 'super_admin' ? 'Make organiser' : 'Make super admin'}
    </button>
  );
  return (
    <Load query={team}>
      <div className="tblwrap team-list">
        <table>
          <tbody>
            {data?.team.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="flex items-center gap-2">
                    <span className={`avatar sm ${m.role === 'super_admin' ? '' : 'orange'}`} aria-hidden>
                      {m.email.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0" style={{ overflowWrap: 'anywhere' }}>
                      {m.email}
                      {m.id === me.user.id && <span className="muted whitespace-nowrap"> (you)</span>}
                      {m.last_sign_in_at !== undefined && <span className="muted small block">{m.last_sign_in_at ? `Last signed in ${time(m.last_sign_in_at)}` : 'Never signed in'}</span>}
                    </span>
                  </span>
                </td>
                <td>{m.role === 'super_admin' ? <span className="pill solid">Super admin</span> : <span className="pill navy">Organiser</span>}</td>
                <td className="text-right whitespace-nowrap">
                  {resetting === m.id ? (
                    <form
                      className="inline-flex gap-2 items-center"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        void act(async () => {
                          await api(`/admin/team/${m.id}`, { method: 'PATCH', json: { password: newPassword } });
                          setResetting(null);
                          setNewPassword('');
                        }, `New password saved for ${m.email}. Their old sign-in has ended.`);
                      }}
                    >
                      <input className="min-h-[38px]! py-1.5!" style={{ width: 220 }} type="text" autoComplete="off" placeholder="New password, 10+ characters" value={newPassword} onChange={(ev) => setNewPassword(ev.target.value)} aria-label={`New password for ${m.email}`} />
                      <button className="btn sm primary" disabled={newPassword.length < 10}>
                        Save
                      </button>
                    </form>
                  ) : m.id === me.user.id ? (
                    // Your own role only while someone else is a super admin too.
                    supers > 1 && roleButton(m)
                  ) : (
                    <span className="inline-flex gap-2">
                      {roleButton(m)}
                      <button className="btn sm soft" onClick={() => (setResetting(m.id), setNewPassword(''))}>
                        <Icon name="edit" size={16} /> New password
                      </button>
                      <button
                        className={`btn sm danger ${removing === m.id ? 'solid' : ''}`}
                        onClick={() => {
                          if (removing !== m.id) return setRemoving(m.id);
                          setRemoving(null);
                          void act(async () => void (await api(`/admin/team/${m.id}`, { method: 'DELETE' })), `${m.email} was removed and signed out.`);
                        }}
                      >
                        {removing === m.id ? 'Tap again to remove' : 'Remove'}
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && (
        <Note bad={note.bad} kind="ok">
          {note.text}
        </Note>
      )}
      <form onSubmit={add} className="form-section">
        <b>Add someone to the team</b>
        <div className="row">
          <div>
            <label htmlFor="org-email">
              Email <span className="req">*</span>
            </label>
            <input id="org-email" type="email" required value={email} onChange={(ev) => setEmail(ev.target.value)} placeholder="name@college.edu" />
          </div>
          <div>
            <label htmlFor="org-pass">
              Their password <span className="req">*</span> <small>(10 characters or more)</small>
            </label>
            <input id="org-pass" type="text" autoComplete="off" required minLength={10} value={password} onChange={(ev) => setPassword(ev.target.value)} placeholder="10 characters or more" />
          </div>
          <div className="flex-none!">
            <label htmlFor="org-role">Role</label>
            <select id="org-role" value={role} onChange={(ev) => setRole(ev.target.value as Member['role'])}>
              <option value="organiser">Organiser</option>
              <option value="super_admin">Super admin</option>
            </select>
          </div>
          <button className="btn primary flex-none!" disabled={!email || password.length < 10}>
            <Icon name="plus" size={18} /> {role === 'super_admin' ? 'Add super admin' : 'Add organiser'}
          </button>
        </div>
      </form>
      <p className="muted small mt-3 mb-0">An organiser runs events and answers reports. A super admin also manages the team and the OneDrive connection, and can delete events.</p>
    </Load>
  );
}

function MyPassword() {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState<{ bad?: boolean; text: string } | null>(null);
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    try {
      await api('/admin/password', { json: { current, password } });
      setCurrent('');
      setPassword('');
      setNote({ text: 'Password changed. Other devices signed in with the old one are signed out.' });
    } catch (e) {
      setNote({ bad: true, text: (e as Error).message });
    }
  };
  return (
    <form onSubmit={save} className="max-w-[460px]">
      <label htmlFor="pw-current" className="mt-0">
        Current password <span className="req">*</span>
      </label>
      <input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={(ev) => setCurrent(ev.target.value)} />
      <label htmlFor="pw-new">
        New password <span className="req">*</span> <small>(10 characters or more)</small>
      </label>
      <input id="pw-new" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(ev) => setPassword(ev.target.value)} placeholder="10 characters or more" />
      <button className="btn primary mt-4" disabled={!current || password.length < 10}>
        <Icon name="shield" size={18} /> Change password
      </button>
      {note && (
        <Note bad={note.bad} kind="ok">
          {note.text}
        </Note>
      )}
    </form>
  );
}

const ACTIONS: Record<string, string> = {
  login: 'signed in',
  'event.create': 'created an event',
  'event.update': 'changed an event',
  'event.delete': 'deleted an event',
  'event.sync': 'pressed Sync now',
  'event.reread': 'read every photo again',
  'event.folder': 'made the OneDrive folder for an event',
  'media.duplicates': 'looked for duplicates',
  'media.upload': 'added a photo',
  'media.hide': 'hid photos',
  'media.unhide': 'unhid photos',
  'media.approve': 'approved student photos',
  'media.approve_all': 'approved all student photos',
  'media.reject': 'rejected student photos',
  'media.show_anyway': 'showed a photo marked as a copy',
  'request.approved': 'took a reported photo down',
  'request.declined': 'declined a report',
  'onedrive.connect': 'connected OneDrive',
  'onedrive.test': 'ran the connection test',
  'onedrive.check': 'ran Check everything',
  'team.add': 'added an organiser',
  'team.update': 'changed an organiser',
  'team.remove': 'removed an organiser',
  'password.change': 'changed their password',
  'event.auto_close': 'closed an event on its closing day',
  'event.face_expired': 'deleted the face data of an event when its time was up',
  'event.face_delete': 'deleted the face data of an event',
  'alerts.settings': 'changed their email alerts',
};
/** What a removal request's approval did, in place of "took a reported photo down". */
const actionText = (r: { action: string; detail: any }) => (r.action === 'request.approved' && r.detail?.kind === 'removal' ? 'took a student out of the photos they asked about' : ACTIONS[r.action] ?? r.action);

/** Who did what: the audit log of the plan, newest first. */
function Activity() {
  const audit = useApi<{ entries: { actor: string; action: string; detail: any; created_at: string }[] }>('/admin/audit');
  const data = audit.data;
  const [all, setAll] = useState(false);
  const rows = data?.entries ?? [];
  return (
    <Load query={audit}>
      {rows.length === 0 && <p className="muted small m-0">Nothing yet.</p>}
      <ul className="timeline">
        {(all ? rows : rows.slice(0, 12)).map((r, i) => (
          <li key={i} className={i === 0 ? 'now' : ''}>
            <div className="text-[14px]">
              <b>{r.actor === 'system' ? 'The app' : r.actor}</b> {actionText(r)}
              {r.detail?.title ? `: ${r.detail.title}` : r.detail?.email ? `: ${r.detail.email}` : r.detail?.name ? `: ${r.detail.name}` : r.detail?.count ? ` (${r.detail.count})` : ''}
            </div>
            <div className="when">{time(r.created_at)}</div>
          </li>
        ))}
      </ul>
      {rows.length > 12 && !all && (
        <button className="btn sm soft" onClick={() => setAll(true)}>
          Show the last {rows.length}
        </button>
      )}
    </Load>
  );
}

function OneDriveSettings() {
  const me = useContext(MeCtx)!;
  const [params] = useSearchParams();
  const status = useApi<{ status: any; setup: { redirect_uri: string; https: boolean; may_connect: boolean } }>('/admin/onedrive/status');
  const data = status.data;
  const st = data?.status;
  const setup = data?.setup;
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
  const refused = params.get('onedrive') === 'appfolder';
  return (
    <>
      {params.get('onedrive') === 'connected' && <Note kind="ok">OneDrive is connected. Press Check everything to make sure every step works with your account.</Note>}
      {params.get('onedrive') === 'account' && (
        <>
          <Note bad>{params.get('reason')} Nothing was changed.</Note>
          <p className="muted small max-w-[70ch]">
            Moving everything to that other account on purpose? <a href={`/admin/onedrive/connect?switch=1&mode=${params.get('mode') === 'folder' ? 'folder' : 'approot'}`}>Use the new account anyway</a>. Each event then needs its folder picked again, from the new account's OneDrive.
          </p>
        </>
      )}
      {params.get('onedrive') === 'error' && <Note bad>OneDrive could not be connected. {params.get('reason')}</Note>}

      <Section icon="cloud" title="OneDrive" edge="navy">
        <Load query={status}>
          {st && setup && st.kind === 'local' && (
            <>
              <Note>This server is in demo mode: a folder on its own disk stands in for OneDrive ({st.rootName}).</Note>
              <h3 className="mt-4 mb-2">To use your college OneDrive</h3>
              <ol className="list-decimal pl-5 grid gap-2 text-[14px]">
                <li>
                  In the Microsoft Entra admin center, register an app named Event Photos, for accounts in your directory only. Platform: Web, with exactly this redirect URI:
                  <span className="flex flex-wrap items-center gap-2 mt-1">
                    <code className="break-all">{setup.redirect_uri}</code>
                    <Copy text={setup.redirect_uri} />
                  </span>
                </li>
                <li>Under API permissions add Microsoft Graph, delegated: Files.ReadWrite.AppFolder and offline_access.</li>
                <li>Under Certificates & secrets create a client secret and copy its Value at once.</li>
                <li>
                  Put three lines into the file server/.env and start the app again: <code>MS_TENANT_ID</code> (Directory ID), <code>MS_CLIENT_ID</code> (Application ID), <code>MS_CLIENT_SECRET</code> (the secret's Value).
                </li>
                <li>Come back to this page: it then shows Connect OneDrive.</li>
              </ol>
              {!setup.https && <p className="muted small">The one link is not https yet ({me.public_url}). That is fine on this computer; phones open the camera only on https.</p>}
              <CheckEverything />
            </>
          )}
          {st && setup && st.kind === 'graph' && (
            <>
              {refused && (
                <Note bad>
                  {params.get('reason')} Microsoft's own pages disagree on whether a college account may use an app's own folder, and yours does not. The way on is the wider permission: the app is then allowed to reach your whole OneDrive, and it keeps to one folder
                  named Event Photos. In Microsoft Entra, under API permissions, add Files.ReadWrite (delegated). Then press Connect with the wider permission.
                </Note>
              )}
              <div className="kv">
                <div>
                  <span>Status</span>
                  <b>{st.connected ? <span className="pill green">Connected</span> : st.needsReconnect ? <span className="pill red">Sign-in expired: reconnect</span> : <span className="pill gray">Not connected</span>}</b>
                </div>
                <div>
                  <span>Account</span>
                  <b>{st.account ?? 'unknown'}</b>
                </div>
                <div>
                  <span>Folder</span>
                  <b>{st.rootName ?? 'not set yet'}</b>
                </div>
              </div>
              <details className="more mb-3">
                <summary>Technical details</summary>
                <div className="in">
              <div className="kv mb-0">
                {st.mode && (
                  <div>
                    <span>The app can reach</span>
                    <b>{st.mode === 'folder' ? 'The files this account can open (wider permission). It keeps to the folder above.' : 'Only its own folder.'}</b>
                  </div>
                )}
                {st.quota && (
                  <div>
                    <span>Space</span>
                    <b>
                      {gb(st.quota.remaining)} free of {gb(st.quota.total)}
                    </b>
                  </div>
                )}
                <div>
                  <span>Redirect URI to register</span>
                  <b className="flex flex-wrap items-center justify-end gap-2">
                    <code className="break-all">{setup.redirect_uri}</code>
                    <Copy text={setup.redirect_uri} />
                  </b>
                </div>
              </div>
                </div>
              </details>
              {setup.may_connect ? (
                <div className="flex flex-wrap gap-2">
                  <a className={refused ? 'btn' : 'btn primary'} href={`/admin/onedrive/connect${st.mode === 'folder' ? '?mode=folder' : ''}`}>
                    <Icon name="cloud" size={18} /> {st.connected ? 'Connect again' : st.needsReconnect ? 'Reconnect OneDrive' : 'Connect OneDrive'}
                  </a>
                  {(refused || (!st.connected && st.mode !== 'folder')) && (
                    <a className={refused ? 'btn primary' : 'btn'} href="/admin/onedrive/connect?mode=folder">
                      Connect with the wider permission
                    </a>
                  )}
                </div>
              ) : (
                <p className="muted small">Only a super admin can connect OneDrive.</p>
              )}
              <p className="muted small">
                You are sent to Microsoft's sign-in page and come back here. Sign in with the account whose OneDrive holds the photos.
                {st.connected && ' Connect again only with the same account: the event folders belong to it.'}
                {!st.connected && !refused && st.mode !== 'folder' && " Start with Connect OneDrive. The wider permission is for a Microsoft 365 that does not allow an app its own folder: this page tells you if yours is one."}
              </p>
              {st.connected && <CheckEverything />}
            </>
          )}
        </Load>
      </Section>
    </>
  );
}

/** The campuses: Hyderabad, Chebrolu, Budampadu ... A super admin adds, renames and removes them. */
function Campuses() {
  const me = useContext(MeCtx)!;
  const qc = useQueryClient();
  const list = useCampuses();
  const boss = me.user.role === 'super_admin';
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [note, setNote] = useState<{ bad?: boolean; text: string } | null>(null);
  const notReady = list.error instanceof ApiError && list.error.status === 404 && !list.isFetching;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setNote({ text: done });
      void qc.invalidateQueries({ queryKey: apiKey('/admin/campuses') });
      void qc.invalidateQueries({ queryKey: apiKey('/campuses') });
      void qc.invalidateQueries({ queryKey: apiKey('/admin/events') });
    } catch (e) {
      setNote({ bad: true, text: (e as Error).message });
    }
  };
  if (notReady) return <Note kind="warn">Campuses need the latest server update.</Note>;
  return (
    <Load query={list}>
      <p className="muted small mt-0">Each campus has its own link and QR (Share kit), and each event can belong to one.</p>
      {list.data?.campuses.length === 0 && <p className="muted">No campuses yet.</p>}
      <ul className="list-none p-0 m-0 grid gap-2">
        {list.data?.campuses.map((c) => (
          <li key={c.id} className="campus-row">
            {editing?.id === c.id ? (
              <form
                className="flex flex-1 gap-2 items-center min-w-[240px]"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  const to = editing.name.trim();
                  setEditing(null);
                  void act(() => api(`/admin/campuses/${c.id}`, { method: 'PATCH', json: { name: to } }), `Renamed to ${to}.`);
                }}
              >
                <input aria-label={`New name for ${c.name}`} value={editing.name} onChange={(ev) => setEditing({ id: c.id, name: ev.target.value })} autoFocus className="min-h-[40px]! py-1.5!" />
                <button className="btn sm primary" disabled={editing.name.trim().length < 2}>
                  Save
                </button>
                <button type="button" className="btn sm" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <Icon name="pin" size={18} className="text-brand" />
                <b className="cr-name">{c.name}</b>
                {c.events !== undefined && <span className="muted small">{c.events === 1 ? '1 event' : `${c.events} events`}</span>}
                {boss && (
                  <>
                    <button className="btn sm soft" onClick={() => setEditing({ id: c.id, name: c.name })} aria-label={`Rename ${c.name}`}>
                      <Icon name="edit" size={16} /> Rename
                    </button>
                    <button
                      className={`btn sm danger ${removing === c.id ? 'solid' : ''}`}
                      onClick={() => {
                        if (removing !== c.id) return setRemoving(c.id);
                        setRemoving(null);
                        void act(() => api(`/admin/campuses/${c.id}`, { method: 'DELETE' }), `${c.name} was removed. Its events stay, without a campus.`);
                      }}
                    >
                      {removing === c.id ? 'Tap again to remove' : 'Remove'}
                    </button>
                  </>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {note && (
        <Note bad={note.bad} kind="ok">
          {note.text}
        </Note>
      )}
      {boss ? (
        <form
          className="row mt-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            const n = name.trim();
            setName('');
            void act(() => api('/admin/campuses', { json: { name: n } }), `${n} was added.`);
          }}
        >
          <div>
            <label htmlFor="campus-name">New campus</label>
            <input id="campus-name" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Hyderabad" maxLength={60} />
          </div>
          <button className="btn primary flex-none!" disabled={name.trim().length < 2}>
            <Icon name="plus" size={18} /> Add campus
          </button>
        </form>
      ) : (
        <p className="muted small mt-3 mb-0">Only a super admin changes the campuses.</p>
      )}
    </Load>
  );
}

/** GB the way the alerts say it: 10 GB, 3 GB, 2.5 GB. */
const gbs = (n: number) => `${+(n / 1024 ** 3).toFixed(1)} GB`;

/** Settings > Alerts and storage: email alerts for the signed-in super admin, and a test email. */
function AlertsCard() {
  const qc = useQueryClient();
  const path = '/admin/alerts/settings';
  const settings = useApi<AlertSettings>(path);
  const s = settings.data;
  const save = useMutation({
    mutationFn: (on: boolean) => api<AlertSettings>(path, { method: 'PATCH', json: { email_alerts: on } }),
    onSuccess: (d) => qc.setQueryData(apiKey(path), d),
  });
  const test = useMutation({ mutationFn: () => api<{ sent: boolean; to: string }>('/admin/alerts/test', { method: 'POST' }) });
  const hour = s?.digest_hour;
  const hint = `Sync failures, OneDrive, backups, disk space and face recognition. At most one email per problem every 12 hours, and one when it is fixed.${
    hour == null ? '' : ` Plus a morning summary at ${String(hour).padStart(2, '0')}:00 when uploads or requests are waiting.`
  }`;
  return (
    <Section icon="bell" colour="red" title="Alerts" edge="red">
      <Load query={settings}>
        {s && (
          <>
            <p className="muted small mt-0">Problems show at the top of every page of the console while they last.</p>
            {s.smtp ? (
              <Toggle label="Email me about problems" hint={hint} checked={save.isPending ? !!save.variables : s.email_alerts} disabled={save.isPending} onChange={(on) => save.mutate(on)} />
            ) : (
              <Note kind="warn">Email is not set up on this server, so alerts show only here in the console. To get them by email, set SMTP_URL in server/.env and restart.</Note>
            )}
            {save.error && <Note bad>{save.error.message}</Note>}
            <div className="flex flex-wrap items-center gap-3 mt-3">
              <button type="button" className="btn soft" onClick={() => test.mutate()} disabled={!s.smtp || test.isPending}>
                <Icon name="mail" size={18} /> {test.isPending ? 'Sending…' : 'Send a test email'}
              </button>
              {s.smtp && s.email && <span className="muted small">To {s.email}</span>}
            </div>
            {test.data && <Note kind="ok">{`Sent to ${test.data.to}.`}</Note>}
            {test.error && <Note bad>{test.error.message}</Note>}
          </>
        )}
      </Load>
    </Section>
  );
}

interface BackupStatus {
  dir: string | null;
  last_at: string | null;
  last_error: string | null;
}

/**
 * Settings > Alerts and storage: where photos and videos are (Microsoft OneDrive only: the originals and the app's own
 * copies), and what the app keeps on the computer it runs on (the database, backups, a small photo cache, temporary
 * files), called "this Mac" or "this server (its address)". Only the app's own files and that disk's free space are
 * shown, nothing else of the system.
 */
function StorageCard() {
  const report = useApi<StorageReport>('/admin/storage');
  // The backups' state comes with the OneDrive status (super admins only).
  const backup = useApi<{ backup?: BackupStatus }>('/admin/onedrive/status').data?.backup;
  const r = report.data;
  const here = r?.machine === 'server' ? 'server' : 'Mac';
  const used = r && r.disk.total > 0 ? Math.min(100, Math.max(0, Math.round(((r.disk.total - r.disk.free) / r.disk.total) * 100))) : 0;
  const q = r?.onedrive.quota ?? null;
  const odUsed = q && q.total > 0 ? Math.min(100, Math.max(0, Math.round((q.used / q.total) * 100))) : 0;
  const amount = (n: number) => (n > 0 ? size(n) : 'None');
  const paused = !!r && r.disk.free < r.min_free_upload;
  const low = !!r && !paused && r.disk.free < r.warn_below;
  const fix = here === 'server' ? 'Give the server a bigger disk, or free up space on it.' : 'Free up space on the Mac.';
  // "This server (stmarys-event-scanner.supercxo.ai)": which server, so nobody takes it for their own computer.
  const where = here === 'server' && r?.host ? `This server (${r.host})` : `This ${here}`;
  return (
    <Section icon="chart" title="Storage" edge="navy">
      <Load query={report}>
        {r && (
          <>
            <p className="muted small mt-0">
              Photos and videos are stored only in Microsoft OneDrive: your originals and the app's own copies (thumbnails, web copies, video previews, download copies) in the folder{' '}
              <code>_app copies (do not edit)</code>.{' '}
              {`${where} keeps only the database (settings, face data), backups, a small photo cache and short-lived temporary files. Every upload passes through it on the way to OneDrive, so it needs some free space.`}
            </p>
            <p className="storage-free m-0">
              <b>{`${where}: ${size(r.disk.free)} free of ${size(r.disk.total)}`}</b>
            </p>
            <div className="meter storage-meter" role="progressbar" aria-label={`Space used on this ${here}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
              <i style={{ width: `${used}%` }} className={paused ? 'bad' : low ? 'low' : ''} />
            </div>
            <p className="muted small mt-1">
              {used}% used. Measured on the disk that holds <code className="break-all">{r.disk.path}</code>.
            </p>
            {paused ? (
              <Note bad>{`Uploads are paused: less than ${gbs(r.min_free_upload)} free for temporary files. ${fix}`}</Note>
            ) : (
              low && <Note kind="warn">{`Less than ${gbs(r.warn_below)} free. Uploads stop below ${gbs(r.min_free_upload)}. ${fix}`}</Note>
            )}
            <div className="kv mb-0">
              <div>
                <span>Database</span>
                <b>{amount(r.server.database)}</b>
              </div>
              <div>
                <span>Backups</span>
                <b>{r.backups_on ? amount(r.server.backups) : 'Off'}</b>
              </div>
              <div>
                <span>Temporary files</span>
                <b>{amount(r.server.temp)}</b>
              </div>
              <div>
                <span>Photo cache</span>
                <b>
                  {r.cache_max > 0 ? amount(r.server.cache ?? 0) : 'Off'}
                  {r.cache_max > 0 && <span className="muted small block font-normal">{`Recent thumbnails and photos, kept here for speed: at most ${size(r.cache_max)}`}</span>}
                </b>
              </div>
              {r.server.legacy_copies > 0 && (
                <div>
                  <span>{`Old copies still on this ${here}`}</span>
                  <b>
                    {amount(r.server.legacy_copies)}
                    <span className="muted small block font-normal">Moved to OneDrive by themselves, then removed here.</span>
                  </b>
                </div>
              )}
              {r.backups_on && backup && (
                <div>
                  <span>Last backup</span>
                  <b>
                    {backup.last_at ? time(backup.last_at) : 'None yet'}
                    {backup.dir && <span className="muted small block font-normal break-all">{`In ${backup.dir}`}</span>}
                  </b>
                </div>
              )}
            </div>
            {r.backups_on && backup?.last_error && <Note bad>{`The last backup did not work: ${backup.last_error}`}</Note>}

            <h3 className="mt-4 mb-2">OneDrive</h3>
            {q ? (
              <>
                <p className="storage-free m-0">
                  <b>{`OneDrive: ${size(q.used)} used of ${size(q.total)}`}</b>
                </p>
                <div className="meter storage-meter" role="progressbar" aria-label="Space used in OneDrive" aria-valuemin={0} aria-valuemax={100} aria-valuenow={odUsed}>
                  <i style={{ width: `${odUsed}%` }} className={q.remaining < q.total * 0.03 ? 'bad' : q.remaining < q.total * 0.1 ? 'low' : ''} />
                </div>
              </>
            ) : (
              <p className="muted small mt-0">{r.onedrive.connected ? 'OneDrive did not say how much space it has.' : 'OneDrive is not connected.'}</p>
            )}
            <div className="kv mb-0">
              <div>
                <span>App copies in OneDrive</span>
                <b>{r.onedrive.copies == null ? 'Not known' : amount(r.onedrive.copies)}</b>
              </div>
              <div>
                <span>Copies being rebuilt</span>
                <b>{r.copies.waiting > 0 ? `${r.copies.waiting}${r.copies.running ? ', working' : ''}` : 'None'}</b>
              </div>
              <div>
                <span>Photos that cannot be shown</span>
                <b>
                  {r.copies.lost > 0 ? r.copies.lost : 'None'}
                  {r.copies.lost > 0 && <span className="muted small block font-normal">Their originals are no longer in OneDrive. See Photos › Cannot be shown in the event.</span>}
                </b>
              </div>
            </div>
            {r.copies.last_error && r.copies.waiting > 0 && <Note kind="warn">{`Last problem making a copy: ${r.copies.last_error}`}</Note>}
            {here === 'Mac' && (
              <p className="muted small mt-2 mb-0">
                If the OneDrive app on this Mac syncs the Event Photos folder, set <code>_app copies (do not edit)</code> to "Free up space" (online only), so the copies do not fill this Mac.
              </p>
            )}
          </>
        )}
      </Load>
    </Section>
  );
}

type SettingsTab = 'onedrive' | 'campuses' | 'team' | 'alerts' | 'password' | 'more';

function Settings() {
  const me = useContext(MeCtx)!;
  const [params, setParams] = useSearchParams();
  const boss = me.user.role === 'super_admin';
  const asked = params.get('tab') as SettingsTab | null;
  // Team, and Alerts and storage, are for super admins: an organiser asking for them gets OneDrive.
  const tab: SettingsTab = asked && ((asked !== 'team' && asked !== 'alerts') || boss) ? asked : 'onedrive';
  const items: { key: SettingsTab; label: string }[] = [
    { key: 'onedrive', label: 'OneDrive' },
    { key: 'campuses', label: 'Campuses' },
    ...(boss ? [{ key: 'team' as const, label: 'Team' }] : []),
    ...(boss ? [{ key: 'alerts' as const, label: 'Alerts and storage' }] : []),
    { key: 'password', label: 'My password' },
    { key: 'more', label: 'More' },
  ];
  return (
    <div className="max-w-[880px]">
      <p className="eyebrow">The console</p>
      <Head title="Settings" />
      <Tabs<SettingsTab> label="Settings" value={tab} items={items} onChange={(k) => setParams({ tab: k }, { replace: true })} />
      <div role="tabpanel">
        {tab === 'onedrive' && <OneDriveSettings />}
        {tab === 'campuses' && (
          <Section icon="pin" title="Campuses" edge="navy">
            <Campuses />
          </Section>
        )}
        {tab === 'team' && boss && (
          <Section icon="users" colour="blue" title="Team" edge="blue">
            <Team />
          </Section>
        )}
        {tab === 'alerts' && boss && (
          <>
            <AlertsCard />
            <StorageCard />
          </>
        )}
        {tab === 'password' && (
          <Section icon="shield" colour="green" title="My password" edge="green">
            <MyPassword />
          </Section>
        )}
        {tab === 'more' && (
          <>
            <Section icon="qr" title="The one QR for every event">
              <p className="muted small mt-0">One link and one QR for all events, to print once: notice boards, ID cards, the college website.</p>
              <div className="flex flex-wrap gap-2">
                <Link className="btn soft" to="/admin/share">
                  <Icon name="qr" size={18} /> Open the one QR
                </Link>
                <Link className="btn" to="/admin/requests">
                  <Icon name="bell" size={18} /> Reports from students
                </Link>
              </div>
            </Section>
            <Section icon="list" colour="orange" title="Who did what">
              <Activity />
            </Section>
            <Section icon="settings" colour="gray" title="This server">
              <div className="kv mb-0">
                <div>
                  <span>The one link</span>
                  <b className="mono text-[13px]">{me.public_url}</b>
                </div>
                <div>
                  <span>Face recognition</span>
                  <b>{me.face_service ? <span className="pill green">Running</span> : <span className="pill red">Not running</span>}</b>
                </div>
                <div>
                  <span>Contact shown to students</span>
                  <b>{me.contact ?? <span className="muted font-normal">Not set. Add a line CONTACT=IT Help Desk, helpdesk@college.edu to server/.env</span>}</b>
                </div>
                <div>
                  <span>Signed in as</span>
                  <b>
                    {me.user.email} ({me.user.role === 'super_admin' ? 'super admin' : 'organiser'})
                  </b>
                </div>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

export function AdminApp(): ReactNode {
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route path="forgot" element={<ForgotPassword />} />
      <Route path="reset" element={<ResetPassword />} />
      <Route element={<Shell />}>
        <Route index element={<Events />} />
        <Route path="events/new" element={<NewEvent />} />
        <Route path="events/:id" element={<EventPage />} />
        <Route path="requests" element={<Requests />} />
        <Route path="share" element={<ShareKit />} />
        <Route path="settings" element={<Settings />} />
        <Route path="people" element={<People />} />
        <Route path="people/new" element={<NewPerson />} />
        <Route path="people/:id" element={<PersonPage />} />
      </Route>
    </Routes>
  );
}
