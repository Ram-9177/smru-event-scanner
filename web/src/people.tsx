import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiError, uploadFile, type Campus, type Photo } from './lib/api';
import { apiKey, under, useApi } from './lib/query';
import { DropZone, Empty, Face, frameNo, Head, Icon, Load, MediaGrid, Note, Tabs, tilt, Viewer } from './ui';

// People: the university's main people. Each has 1-5 reference face photos; the server files every photo they are in
// into their own OneDrive folder, sorted into Solo (alone), Duo (with one other) and Group.
// In the darkroom: each person is a portrait print, their face photos are Polaroids, their photos a contact sheet.

export interface Person {
  id: string;
  name: string;
  role: string;
  campus: Campus | null;
  photo: string | null;
  refs: number;
  counts: { solo: number; duo: number; group: number };
  folder: string | null;
}
type Kind = 'solo' | 'duo' | 'group';
interface PersonMedia extends Photo {
  kind: Kind;
  similarity: number;
  event: { id: string; title: string; slug: string };
}

const MAX_REFS = 5;
const KINDS: { key: Kind; label: string; what: string }[] = [
  { key: 'solo', label: 'Solo', what: 'alone in the photo' },
  { key: 'duo', label: 'Duo', what: 'with one other person' },
  { key: 'group', label: 'Group', what: 'with two or more others' },
];
/** Suggestions only: any role can be typed. */
const ROLES = ['Chairman', 'Vice Chairman', 'Secretary', 'CEO', 'COO', 'CFO', 'Vice Chancellor', 'Pro Vice Chancellor', 'Registrar', 'Controller of Examinations', 'Dean', 'Director', 'Principal', 'Vice Principal', 'Head of Department', 'Professor', 'Chief Guest'];

/** "Event Photos › People › Name - Role": the server sends the part after Event Photos. */
const onedrivePath = (folder: string) => `Event Photos › ${/^People\b/.test(folder) ? folder : `People › ${folder}`}`;

const notReady = (e: Error | null) => e instanceof ApiError && e.status === 404;

const total = (c: Person['counts']) => c.solo + c.duo + c.group;

/** Solo, Duo and Group counts, printed along the film edge in amber. */
function Counts({ c }: { c: Person['counts'] }) {
  return (
    <span className="counts3 p-counts">
      <i className="tri" aria-hidden />
      {KINDS.map((k) => (
        <span key={k.key}>
          {k.label} <b>{c[k.key]}</b>
        </span>
      ))}
    </span>
  );
}

/** The outline of a head and shoulders in dashed pencil: where their face photo goes. */
function Silhouette() {
  return (
    <svg className="p-sil" viewBox="0 0 120 130" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="5 6" aria-hidden>
      <circle cx="60" cy="58" r="25" />
      <path d="M14 130 C14 104 36 92 60 92 C84 92 106 104 106 130" />
    </svg>
  );
}

/** A tilt for a print on the line, steady for the same id. */
const hung = (id: string, max = 1.6) => ({ '--r': `${tilt(id, max)}deg` }) as CSSProperties;

/** How People works, as three paper slips. */
function HowItWorks() {
  return (
    <section className="p-howto" aria-labelledby="how-h">
      <h2 id="how-h" className="edge-print">
        How it works
      </h2>
      <ol className="p-how">
        <li className="slip">
          <i>01</i>
          <b>Add the person</b>
          <span>Their name, role and campus.</span>
        </li>
        <li className="slip">
          <i>02</i>
          <b>Give one clear face photo</b>
          <span>One person, face clearly visible.</span>
        </li>
        <li className="slip">
          <i>03</i>
          <b>Photos file themselves</b>
          <span>Into Solo, Duo and Group in OneDrive.</span>
        </li>
      </ol>
    </section>
  );
}

function useCampusList() {
  return useApi<{ campuses: Campus[] }>('/admin/campuses', { staleTime: 60_000 }).data?.campuses;
}

/** Name, role (with suggestions) and campus: the same fields to add and to edit. */
function PersonFields({ name, role, campus, set }: { name: string; role: string; campus: string; set: (p: Partial<{ name: string; role: string; campus: string }>) => void }) {
  const campuses = useCampusList();
  return (
    <>
      <label htmlFor="p-name" className="mt-0!">
        Name <span className="req">*</span>
      </label>
      <input id="p-name" value={name} onChange={(e) => set({ name: e.target.value })} required minLength={2} maxLength={80} placeholder="Dr. K. V. K. Rao" autoComplete="off" />
      <label htmlFor="p-role">
        Role <small>(pick one or type your own)</small>
      </label>
      <input id="p-role" list="p-roles" value={role} onChange={(e) => set({ role: e.target.value })} maxLength={60} placeholder="Chairman" autoComplete="off" />
      <datalist id="p-roles">
        {ROLES.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      {campuses && (
        <>
          <label htmlFor="p-campus">
            Campus <small>(optional)</small>
          </label>
          <select id="p-campus" value={campus} onChange={(e) => set({ campus: e.target.value })}>
            <option value="">All campuses</option>
            {campuses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </>
      )}
    </>
  );
}

export function People() {
  const list = useApi<{ people: Person[] }>('/admin/people');
  const people = list.data?.people ?? [];
  return (
    <div className="p-bench">
      <div className="hello p-top">
        <div className="min-w-0 max-w-[60ch]">
          <p className="edge-print">People · OneDrive</p>
          <h1>
            Main <span className="g">people</span>
          </h1>
          <p className="note-hand p-note">every photo of them, filed for you</p>
          <p className="muted m-0">The university's main people. Every photo and video they are in is filed into their own OneDrive folder: alone, with one other person, or in a group.</p>
        </div>
        <Link className="btn primary" to="/admin/people/new">
          <Icon name="plus" size={18} /> Add person
        </Link>
      </div>
      {notReady(list.error) && !list.isFetching ? (
        <Note kind="warn" title="People is not ready on this server yet">
          It needs the latest server update. Everything else works as before.
        </Note>
      ) : (
        <Load query={list}>
          {people.length === 0 && <p className="note-hand p-none">no people yet: start with the Chairman or the Vice Chancellor</p>}
          {/* The bench: each person a print of their face, hanging from a peg on the drying line. */}
          <ul className="p-line" aria-label="People">
            {people.map((p, i) => {
              const where = p.folder ? onedrivePath(p.folder) : 'Folder is made with their first photo';
              // Every path starts "Event Photos › People ›", so the edge prints only the part that differs per person.
              const edge = p.folder ? p.folder.replace(/^People › /, '') : where;
              return (
                <li key={p.id} className="p-cell" style={hung(p.id)}>
                  <Link className="p-link" to={`/admin/people/${p.id}`}>
                    <i className="peg" aria-hidden />
                    <span className="hang">
                      <span className="print p-print">
                        <span className="p-well">
                          {p.photo ? (
                            <img className="devin" src={p.photo} alt="" loading="lazy" style={{ '--d': `${Math.min(i, 12) * 90}ms` } as CSSProperties} />
                          ) : (
                            <>
                              <Silhouette />
                              <Face src={null} name={p.name} />
                            </>
                          )}
                        </span>
                        <b className="p-name">{p.name}</b>
                        <span className="p-role">{[p.role, p.campus?.name].filter(Boolean).join(' · ') || 'No role yet'}</span>
                      </span>
                    </span>
                    <span className="p-below">
                      {p.refs === 0 ? <span className="pill orange stamp">Add a face photo</span> : <Counts c={p.counts} />}
                      <span className="p-edge" title={where}>
                        <i>{frameNo(i)}</i> {edge}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
            {/* The empty place at the end of the line: hang the next portrait. */}
            <li className={`p-cell p-slotcell ${people.length === 0 ? 'first' : ''}`}>
              <i className="peg" aria-hidden />
              <Link className="p-slot" to="/admin/people/new">
                <span className="st">
                  <Icon name="plus" size={22} /> {people.length === 0 ? 'Hang the first portrait' : 'Hang another portrait'}
                </span>
                <span className="sd">{people.length === 0 ? 'Their name and role, then one clear face photo.' : 'Name and role, then one clear face photo.'}</span>
              </Link>
            </li>
          </ul>
        </Load>
      )}
      <HowItWorks />
    </div>
  );
}

export function NewPerson() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', role: '', campus: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { person } = await api<{ person: Person }>('/admin/people', { json: { name: f.name.trim(), role: f.role.trim(), campus_id: f.campus || null } });
      void qc.invalidateQueries({ queryKey: apiKey('/admin/people') });
      nav(`/admin/people/${person.id}`, { state: { fresh: true } });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const name = f.name.trim();
  const role = f.role.trim();
  return (
    <form onSubmit={submit} className="p-new">
      <Head back="/admin/people" title="Add person" />
      <ol className="p-steps" aria-label="Steps">
        <li aria-current="step">
          <i>01</i> Who they are
        </li>
        <li>
          <i>02</i> Their face photos
        </li>
      </ol>
      <div className="p-new-body">
        <div className="card">
          <p className="muted small mt-0">Step 1 of 2: who they are. Next you add their face photos.</p>
          <PersonFields name={f.name} role={f.role} campus={f.campus} set={(p) => setF((x) => ({ ...x, ...p }))} />
          {error && <Note bad>{error}</Note>}
          <button className="btn primary big mt-5" disabled={busy || name.length < 2}>
            {busy ? 'Saving…' : 'Next: add face photos'} <Icon name="chev" size={18} />
          </button>
        </div>
        {/* A preview of their print on the line and of their folder, filled in as the name is typed. */}
        <div className="p-new-print" aria-hidden>
          <div className="p-cell" style={{ '--r': '-1.6deg' } as CSSProperties}>
            <i className="peg" />
            <span className="hang">
              <span className="print p-print sway">
                <span className="p-well">
                  <Silhouette />
                  <span className="p-say">face photo next</span>
                </span>
                <b className="p-name">{name || 'Their name'}</b>
                <span className="p-role">{role || 'their role'}</span>
              </span>
            </span>
          </div>
          <p className="edge-print p-folder-line">
            Event Photos › People › {name || 'Name'}
            {role ? ` - ${role}` : ''}
          </p>
        </div>
      </div>
    </form>
  );
}

interface RefResult {
  name: string;
  ok: boolean;
  message: string;
}

export function PersonPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const fresh = !!(useLocation().state as { fresh?: boolean } | null)?.fresh;
  const path = `/admin/people/${id}`;
  const q = useApi<{ person: Person; refs: { id: string; thumb: string | null }[] }>(path);
  const person = q.data?.person;
  const refs = q.data?.refs ?? [];
  const [picked, setPicked] = useState<Kind | null>(null);
  const kind: Kind = picked ?? (person ? KINDS.find((k) => person.counts[k.key] > 0)?.key ?? 'solo' : 'solo');
  const media = useApi<{ media: PersonMedia[] }>(`${path}/media?kind=${kind}`, { enabled: !!person, placeholderData: keepPreviousData });
  const items = media.data?.media ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const onClose = useCallback(() => setOpen(null), []);
  const [adding, setAdding] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<RefResult[]>([]);
  const [refile, setRefile] = useState<{ busy?: boolean; bad?: boolean; text?: string }>({});
  const [edit, setEdit] = useState<{ name: string; role: string; campus: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const reread = () => {
    void qc.invalidateQueries(under(path));
    void qc.invalidateQueries({ queryKey: apiKey('/admin/people') });
  };

  const addPhotos = async (files: File[]) => {
    const room = MAX_REFS - refs.length;
    const take = files.slice(0, Math.max(0, room));
    const out: RefResult[] = files.slice(take.length).map((f) => ({ name: f.name, ok: false, message: `Not added: ${MAX_REFS} face photos is the most.` }));
    setResults([]);
    setAdding({ done: 0, total: take.length });
    for (const [i, f] of take.entries()) {
      try {
        if (!f.type.startsWith('image/')) throw new ApiError(415, 'unsupported', 'That is not a photo.');
        await uploadFile(`${path}/photos`, f);
        out.unshift({ name: f.name, ok: true, message: 'Added.' });
      } catch (err) {
        const e = err as ApiError;
        const message = e.code === 'no_face' ? e.message || 'No face was found in that photo.' : e.code === 'many_faces' ? e.message || 'That photo has more than one person in it.' : e.message;
        out.push({ name: f.name, ok: false, message });
      }
      setAdding({ done: i + 1, total: take.length });
      setResults([...out]);
    }
    setAdding(null);
    setResults([...out]);
    reread();
  };
  const removeRef = async (refId: string) => {
    if (removing !== refId) return setRemoving(refId);
    setRemoving(null);
    try {
      await api(`${path}/photos/${refId}`, { method: 'DELETE' });
    } catch (err) {
      setResults([{ name: 'Face photo', ok: false, message: (err as Error).message }]);
    }
    reread();
  };
  const fileAgain = async () => {
    setRefile({ busy: true });
    try {
      const { filed } = await api<{ filed: number }>(`${path}/refile`, { method: 'POST' });
      setRefile({ text: filed === 1 ? '1 photo or video is in their folder.' : `${filed} photos and videos are in their folder.` });
      reread();
    } catch (err) {
      setRefile({ bad: true, text: (err as Error).message });
    }
  };
  const saveEdit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!edit) return;
    setEditError(null);
    try {
      await api(path, { method: 'PATCH', json: { name: edit.name.trim(), role: edit.role.trim(), campus_id: edit.campus || null } });
      setEdit(null);
      reread();
    } catch (err) {
      setEditError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!ask) return setAsk(true);
    setRemoveError(null);
    try {
      await api(path, { method: 'DELETE' });
    } catch (err) {
      setRemoveError((err as Error).message);
      setAsk(false);
      return;
    }
    void qc.invalidateQueries({ queryKey: apiKey('/admin/people') });
    nav('/admin/people');
  };

  const shown = KINDS.find((k) => k.key === kind)!;
  const filedCount = person ? total(person.counts) : 0;

  return (
    <Load query={q}>
      {person && (
        <div className="p-page">
          <Head back="/admin/people" title={person.name} />

          {/* Their portrait hangs on the line: the main face photo as a print, the role handwritten under it. Beside it, their label. */}
          <div className="p-head">
            <div className="p-cell p-portrait" style={hung(person.id, 1.4)}>
              <i className="peg" aria-hidden />
              <div className="hang">
                <figure className="print lg p-print m-0">
                  <span className="p-well">
                    {person.photo ? (
                      <img className="devin" src={person.photo} alt="" />
                    ) : (
                      <>
                        <Silhouette />
                        <Face src={null} name={person.name} />
                      </>
                    )}
                  </span>
                  <figcaption className="p-role">{person.role || 'No role yet'}</figcaption>
                </figure>
              </div>
            </div>
            <div className="p-info">
              <p className="edge-print lg m-0">{person.campus ? person.campus.name : 'All campuses'}</p>
              <Counts c={person.counts} />
              <p className="note-hand p-filed-n">{refs.length === 0 ? 'Add a face photo so their photos can be found.' : filedCount === 1 ? '1 photo or video filed so far.' : `${filedCount} photos and videos filed so far.`}</p>
            </div>
            {/* Where their photos go: a paper label with the OneDrive folder, and File again. */}
            <div className="p-where">
              <div className="slip p-folder">
                <Icon name="folder" size={22} className="p-folder-i" />
                <div className="p-folder-t">
                  <p className="m-0">
                    {person.folder ? (
                      <>
                        <span className="muted">Saved in OneDrive:</span> <b>{onedrivePath(person.folder)}</b>
                      </>
                    ) : (
                      <span className="muted">Their OneDrive folder is made when the first photo of them is filed.</span>
                    )}
                  </p>
                  {person.folder && <p className="p-inside m-0">Inside: Solo · Duo · Group</p>}
                </div>
                <button type="button" className="btn ink" onClick={fileAgain} disabled={refile.busy || refs.length === 0}>
                  <Icon name="refresh" size={16} /> {refile.busy ? 'Filing…' : 'File again'}
                </button>
              </div>
              {refile.text && (
                <Note bad={refile.bad} kind="ok">
                  {refile.text}
                </Note>
              )}
            </div>
          </div>

          {/* Their reference faces: prints on the line, and the dashed slot at its end to hang more. */}
          <section className="p-sec p-refs" aria-labelledby="refs-h">
            <div className="p-sec-h">
              <p className="edge-print m-0">Reference prints</p>
              <h2 id="refs-h">
                Face photos ({refs.length} of {MAX_REFS})
              </h2>
            </div>
            {refs.length === 0 && (
              <Note kind="info" title={fresh ? 'Step 2 of 2: add 1 to 5 clear face photos' : 'Add 1 to 5 clear face photos'}>
                One person in the photo, face clearly visible. Different photos (other days, with and without glasses) find more.
              </Note>
            )}
            <ul className="p-line p-refline" aria-label="Face photos">
              {refs.map((r, i) => (
                <li key={r.id} className={`p-cell p-ref ${removing === r.id ? 'ask' : ''}`} style={hung(r.id, 2)}>
                  <i className="peg" aria-hidden />
                  <div className="hang">
                    <div className="print p-print">
                      <span className="p-well">
                        {r.thumb ? (
                          <img className="devin" src={r.thumb} alt={`Face photo ${i + 1} of ${person.name}`} style={{ '--d': `${i * 110}ms` } as CSSProperties} />
                        ) : (
                          <span className="muted small">Add this face photo again to see it</span>
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="p-x"
                      onClick={() => removeRef(r.id)}
                      aria-label={removing === r.id ? `Tap again to remove face photo ${i + 1}` : `Remove face photo ${i + 1}`}
                      title={removing === r.id ? 'Tap again to remove' : 'Remove'}
                    >
                      <i>
                        <Icon name={removing === r.id ? 'trash' : 'xmark'} size={15} />
                      </i>
                    </button>
                  </div>
                  <span className="print-tag" aria-hidden>
                    {removing === r.id ? 'tap again to remove' : frameNo(i)}
                  </span>
                </li>
              ))}
              {refs.length < MAX_REFS && (
                <li className={`p-cell p-slotcell ${refs.length === 0 ? 'first' : ''}`}>
                  <i className="peg" aria-hidden />
                  <DropZone
                    icon="camera"
                    title={adding ? `Checking ${adding.done + 1} of ${adding.total}…` : 'Add face photos'}
                    hint="One person in the photo, face clearly visible."
                    accept="image/*"
                    disabled={!!adding}
                    onFiles={addPhotos}
                  />
                </li>
              )}
            </ul>
            {adding && (
              <div className="meter p-meter" role="progressbar" aria-label="Checking face photos" aria-valuenow={adding.done} aria-valuemin={0} aria-valuemax={adding.total}>
                <i style={{ width: `${adding.total ? Math.round((adding.done / adding.total) * 100) : 0}%` }} />
              </div>
            )}
            {results.map((r, i) => (
              <Note key={i} bad={!r.ok} kind="ok">
                <b className="inline">{r.name}:</b> {r.message}
              </Note>
            ))}
          </section>

          {/* Everything filed for them, as a contact sheet: Solo, Duo or Group at a time. */}
          <section className="p-sec p-filed" aria-labelledby="filed-h">
            <div className="p-sec-h">
              <p className="edge-print m-0">Contact sheet</p>
              <h2 id="filed-h">Their photos and videos</h2>
            </div>
            <Tabs<Kind> label="Photos of this person" value={kind} onChange={(k) => (setPicked(k), setOpen(null))} items={(KINDS.some((k) => person.counts[k.key] > 0) ? KINDS.filter((k) => person.counts[k.key] > 0 || k.key === kind) : KINDS.slice(0, 1)).map((k) => ({ key: k.key, label: `${k.label} (${person.counts[k.key]})` }))} small />
            <Load query={media}>
              <div className="sheet">
                {items.length === 0 ? (
                  <Empty icon="image" title="Nothing here yet">
                    {refs.length === 0 ? 'Add a face photo first.' : `${shown.label} is for photos of them ${shown.what}. They show up here as events are filed.`}
                  </Empty>
                ) : (
                  <>
                    <div className="sheet-head">
                      <span>
                        {shown.label} · {shown.what}
                      </span>
                      <span className="muted">{items.length === 1 ? '1 frame' : `${items.length} frames`}</span>
                    </div>
                    <MediaGrid items={items} onOpen={setOpen} />
                  </>
                )}
              </div>
            </Load>
          </section>

          <details className="more">
            <summary>Edit details or remove</summary>
            <div className="in">
              {edit ? (
                <form onSubmit={saveEdit} className="card p-edit">
                  <PersonFields name={edit.name} role={edit.role} campus={edit.campus} set={(p) => setEdit((x) => (x ? { ...x, ...p } : x))} />
                  {editError && <Note bad>{editError}</Note>}
                  <div className="flex flex-wrap gap-2 mt-4">
                    <button className="btn primary">
                      <Icon name="check" size={18} /> Save
                    </button>
                    <button type="button" className="btn" onClick={() => setEdit(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn soft" onClick={() => setEdit({ name: person.name, role: person.role, campus: person.campus?.id ?? '' })}>
                    <Icon name="edit" size={18} /> Edit name, role, campus
                  </button>
                  <button type="button" className={`btn danger ${ask ? 'solid' : ''}`} onClick={remove}>
                    <Icon name="trash" size={18} /> {ask ? 'Tap again to remove' : 'Remove from People'}
                  </button>
                  {ask && (
                    <button type="button" className="btn" onClick={() => setAsk(false)}>
                      Keep them
                    </button>
                  )}
                </div>
              )}
              {removeError && <Note bad>{removeError}</Note>}
              <p className="muted small mb-0">Removing them keeps their OneDrive folder and the copies in it.</p>
            </div>
          </details>

          {open !== null && items[open] && <Viewer photos={items} index={open} onIndex={setOpen} onClose={onClose} canSave original={(p) => `/api/admin/media/${p.id}/original`} caption={(p) => (p as PersonMedia).event?.title} />}
        </div>
      )}
    </Load>
  );
}
