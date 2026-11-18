import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventHome, Find, Home, Mine } from '../student';
import { campuses, media, studentEvent } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const routes = (
  <>
    <Route path="/" element={<Home />} />
    <Route path="/c/:campus" element={<Find />} />
    <Route path="/e/:slug" element={<EventHome />} />
    <Route path="/e/:slug/find" element={<Find />} />
    <Route path="/e/:slug/mine" element={<p>Your photos screen</p>} />
    <Route path="/e/:slug/album" element={<p>The album screen</p>} />
    <Route path="/e/:slug/add" element={<p>The add screen</p>} />
    <Route path="/admin" element={<p>The console</p>} />
  </>
);
const events = (...list: ReturnType<typeof studentEvent>[]) => ({ 'GET /events': { body: { org: "St. Mary's", contact: null, events: list } } });
const shutter = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.fd-dock .shutter')!;
/** The big frame of the event the home shows. */
const frame = (name: RegExp) => screen.findByRole('img', { name });

describe('find: the home shows one event', () => {
  it('shows only the latest event, big, with one red shutter, Add photos and See all', async () => {
    const fresher = studentEvent({ slug: 'fresher-day', title: 'Fresher Day', starts_on: '2026-08-01', campus: campuses[1], cover: '/img/fresher/t' });
    mockFetch(events(studentEvent({ cover: '/img/cover/t' }), fresher));
    const { container } = renderAt('/', routes);
    expect(screen.getByRole('heading', { level: 1, name: 'Find every photo you’re in.' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Annual Day 2026' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /01\s*Your event/ })).toBeInTheDocument();
    const big = await frame(/^Annual Day 2026/);
    // Its cover in true colour: no negatives, no strip of every event.
    expect(big.querySelector('img')).toHaveAttribute('src', '/img/cover/t');
    expect(container.querySelector('.negatives, .film-frame')).not.toBeInTheDocument();
    expect(screen.queryByText('Fresher Day')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /^Fresher Day/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Hyderabad · Main hall · 240 photos/)).toBeInTheDocument();
    // One red shutter, and only one.
    expect(container.querySelectorAll('.shutter')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Take selfie' })).toHaveClass('shutter');
    expect(screen.getByRole('link', { name: 'Add photos' })).toHaveAttribute('href', '/e/annual-day/add');
    expect(screen.getByRole('link', { name: 'See all 240 photos' })).toHaveAttribute('href', '/e/annual-day/album');
    // The consent line is always under the buttons.
    expect(screen.getAllByText(/The selfie is deleted right after the search/).length).toBeGreaterThan(0);
    // No campus chips on the student side.
    expect(screen.queryByRole('group', { name: 'Campus' })).not.toBeInTheDocument();
  });

  it.each([
    ['an open one before one opening soon or a closed one', [['draft', 0], ['closed', 9], ['live', 0]], 'Event 3'],
    ['the last one with photos before one opening soon', [['draft', 0], ['closed', 12], ['closed', 5]], 'Event 2'],
    ['one opening soon before a closed one with no photos', [['closed', 0], ['draft', 0], ['draft', 0]], 'Event 2'],
    ['the newest closed one when nothing else is there', [['closed', 0], ['closed', 0]], 'Event 1'],
  ] as const)('picks %s', async (_, states, title) => {
    const list = states.map(([state, photos], i) => studentEvent({ slug: `event-${i + 1}`, title: `Event ${i + 1}`, state, photos }));
    mockFetch(events(...list));
    renderAt('/', routes);
    expect(await screen.findByRole('heading', { level: 2, name: title })).toBeInTheDocument();
  });

  it('says Soon on an event that is not open yet', async () => {
    mockFetch(events(studentEvent({ state: 'draft', cover: '/img/c/t' })));
    renderAt('/', routes);
    const big = await frame(/^Annual Day 2026, .*opens soon/);
    expect(within(big).getByText('Soon')).toBeInTheDocument();
    expect(screen.getByText(/photos soon/)).toBeInTheDocument();
  });

  it('shows the way to your prints after a search', async () => {
    mockFetch(events(studentEvent({ mine: 4 })));
    const { container } = renderAt('/e/annual-day', routes);
    expect(await screen.findByRole('link', { name: /My 4 prints/ })).toHaveAttribute('href', '/e/annual-day/mine');
    expect(screen.getByRole('link', { name: 'See my 4 prints' })).toHaveAttribute('href', '/e/annual-day/mine');
    expect(shutter(container)).toHaveTextContent('Retake selfie');
    expect(await frame(/^Annual Day 2026.*4 of you$/)).toBeInTheDocument();
  });

  it('says on See all when the album needs a passcode, and has no Add photos when adding is closed', async () => {
    mockFetch(events(studentEvent({ options: { find: true, album: true, album_locked: true, upload: false, download: true } })));
    renderAt('/e/annual-day', routes);
    expect(await screen.findByRole('link', { name: /See all 240 photos, needs the album passcode/ })).toHaveAttribute('href', '/e/annual-day/album');
    expect(screen.queryByRole('link', { name: /Add photos/ })).not.toBeInTheDocument();
  });

  it('turns the shutter off when face search is off, and points to the album', async () => {
    mockFetch(events(studentEvent({ options: { find: false, album: true, album_locked: false, upload: false, download: true } })));
    const { container } = renderAt('/e/annual-day', routes);
    expect(await screen.findByText('Face search is switched off for this event. Use the full album.')).toBeInTheDocument();
    expect(shutter(container)).toBeDisabled();
    expect(screen.getByRole('link', { name: 'See all 240 photos' })).toBeInTheDocument();
  });

  it('says when the album has closed', async () => {
    mockFetch({
      ...events(),
      'GET /e/annual-day': { body: { contact: 'the IT help desk', event: { slug: 'annual-day', title: 'Annual Day 2026', state: 'archived', strip: [], photos: 0, mine: 0, options: { find: false, album: false, album_locked: false, upload: false, download: false } } } },
    });
    const { container } = renderAt('/e/annual-day', routes);
    expect(await screen.findByText('This album has closed.')).toBeInTheDocument();
    expect(screen.getByText(/If you need a photo from it, ask the IT help desk\./)).toBeInTheDocument();
    expect(shutter(container)).toBeDisabled();
  });

  it('shows an unlisted event opened by its own link', async () => {
    mockFetch({ ...events(studentEvent()), 'GET /e/secret-day': { body: { contact: null, event: studentEvent({ slug: 'secret-day', title: 'Secret Day' }) } } });
    const { user } = renderAt('/e/secret-day', routes);
    expect(await screen.findByRole('heading', { level: 2, name: 'Secret Day' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Earlier events' }));
    expect(within(screen.getByRole('dialog', { name: 'Earlier events' })).getByRole('link', { name: /^Annual Day 2026/ })).toBeInTheDocument();
  });

  it('has For organisers as a button at the very bottom of the page', async () => {
    mockFetch(events(studentEvent()));
    const { container } = renderAt('/', routes);
    const staff = await screen.findByRole('link', { name: 'For organisers' });
    expect(staff).toHaveAttribute('href', '/admin');
    expect(staff).toHaveClass('btn');
    // After everything else: the dock, the steps and the add link all come before it.
    const main = container.querySelector('main')!;
    const links = within(main).getAllByRole('link');
    expect(links.at(-1)).toBe(staff);
    expect(container.querySelector('.fd-dock')!.compareDocumentPosition(staff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.fd-grid')!.contains(staff)).toBe(false);
  });
});

describe('find: an event over several days', () => {
  it('shows the days it runs under the frame', async () => {
    mockFetch(events(studentEvent({ starts_on: '2026-11-14', ends_on: '2026-11-16' })));
    renderAt('/e/annual-day', routes);
    expect(await screen.findByText(/^14–16 Nov 2026 · Hyderabad/)).toBeInTheDocument();
    expect(await frame(/^Annual Day 2026, 14–16 Nov 2026,/)).toBeInTheDocument();
  });
});

describe('find: earlier events', () => {
  const annual = studentEvent({ cover: '/img/annual/t' });
  const sports = studentEvent({ slug: 'sports-day', title: 'Sports Day', state: 'draft', starts_on: '2026-10-02', strip: [] });
  const fresher = studentEvent({ slug: 'fresher-day', title: 'Fresher Day', state: 'closed', starts_on: '2026-08-01', mine: 2, cover: '/img/fresher/t' });

  it('lists every other event, newest first, and opens one as the home’s event', async () => {
    mockFetch(events(annual, sports, fresher));
    const { user } = renderAt('/', routes);
    expect(await screen.findByRole('heading', { level: 2, name: 'Annual Day 2026' })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Earlier events' });
    await user.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Earlier events' });
    const rows = within(dialog).getAllByRole('link');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/^Sports Day2 Oct 2026Soon/), expect.stringMatching(/^Fresher Day1 Aug 2026Closed2 of you/)]);
    expect(rows[0]).toHaveAttribute('href', '/e/sports-day');
    // Covers in true colour.
    expect(rows[1].querySelector('img')).toHaveAttribute('src', '/img/fresher/t');

    await user.click(rows[1]);
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/e\/fresher-day$/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Fresher Day' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /My 2 prints/ })).toHaveAttribute('href', '/e/fresher-day/mine');
    expect(screen.getByRole('link', { name: 'See the latest event' })).toHaveAttribute('href', '/');

    // Now the latest one is among the others.
    await user.click(screen.getByRole('button', { name: 'Earlier events' }));
    const again = within(screen.getByRole('dialog', { name: 'Earlier events' })).getAllByRole('link');
    expect(again.map((r) => r.getAttribute('href'))).toEqual(['/e/annual-day', '/e/sports-day']);
    expect(again[0]).toHaveTextContent('Latest');
  });

  it('closes on Escape and puts the focus back on the button', async () => {
    mockFetch(events(annual, fresher));
    const { user } = renderAt('/', routes);
    const button = await screen.findByRole('button', { name: 'Earlier events' });
    await user.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Earlier events' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('is not there when the home has only one event', async () => {
    mockFetch(events(annual));
    renderAt('/', routes);
    expect(await screen.findByRole('heading', { level: 2, name: 'Annual Day 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Earlier events' })).not.toBeInTheDocument();
  });
});

describe('find: one link per campus', () => {
  const annual = studentEvent();
  const fresher = studentEvent({ slug: 'fresher-day', title: 'Fresher Day', mine: 2, campus: campuses[1] });
  const youth = studentEvent({ slug: 'youth-fest', title: 'Youth Fest', state: 'closed', starts_on: '2026-07-01', campus: campuses[1] });
  const byCampus = (c: { path: string }) => ({ body: { org: "St. Mary's", contact: null, events: c.path.includes('campus=chebrolu') ? [fresher, youth] : c.path.includes('campus=') ? [] : [annual, fresher, youth] } });

  it('shows only that campus’s events on its own link, with that link in the QR', async () => {
    const net = mockFetch({ 'GET /campuses': { body: { campuses } }, 'GET /events': byCampus });
    const { user, container } = renderAt('/c/chebrolu', routes);
    expect(await screen.findByRole('heading', { level: 2, name: 'Fresher Day' })).toBeInTheDocument();
    expect(net.called('GET /events?campus=chebrolu').length).toBeGreaterThan(0);
    expect(net.called('GET /events')).toHaveLength(0);
    // No campus chips: the link itself is the campus.
    expect(screen.queryByRole('group', { name: 'Campus' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hyderabad' })).not.toBeInTheDocument();
    // The ticket's QR is the campus link.
    expect(screen.getByRole('img', { name: 'QR code of the Chebrolu campus link' })).toBeInTheDocument();
    expect(container.querySelector('.ticket-l')).toHaveTextContent(/\/c\/chebrolu$/);
    expect(screen.getByText('Chebrolu campus: same QR after every event')).toBeInTheDocument();
    // The event's screens keep the campus, and so do Earlier events.
    expect(screen.getByRole('link', { name: 'See all 240 photos' })).toHaveAttribute('href', '/e/fresher-day/album?campus=chebrolu');
    await user.click(screen.getByRole('button', { name: 'Earlier events' }));
    const rows = within(screen.getByRole('dialog', { name: 'Earlier events' })).getAllByRole('link');
    expect(rows.map((r) => r.getAttribute('href'))).toEqual(['/e/youth-fest?campus=chebrolu']);
    await user.click(rows[0]);
    expect(screen.getByTestId('where')).toHaveTextContent('/e/youth-fest?campus=chebrolu');
    expect(await screen.findByRole('heading', { level: 2, name: 'Youth Fest' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the latest event' })).toHaveAttribute('href', '/c/chebrolu');
  });

  it('keeps the one main link in the QR on the home of all campuses', async () => {
    mockFetch({ 'GET /campuses': { body: { campuses } }, 'GET /events': byCampus });
    const { container } = renderAt('/', routes);
    expect(await screen.findByRole('heading', { level: 2, name: 'Annual Day 2026' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'QR code of the Event Photos link' })).toBeInTheDocument();
    expect(container.querySelector('.ticket-l')?.textContent).not.toMatch(/\/c\//);
    expect(screen.getByText('same QR after every event')).toBeInTheDocument();
  });

  it('sends the old campus address on to the campus link', async () => {
    const net = mockFetch({ 'GET /campuses': { body: { campuses } }, 'GET /events': byCampus });
    renderAt('/?campus=chebrolu', routes);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/c\/chebrolu$/));
    expect(await screen.findByRole('heading', { level: 2, name: 'Fresher Day' })).toBeInTheDocument();
    expect(net.called('GET /events')).toHaveLength(0);
  });

  it('says when a campus link is not right', async () => {
    let answer!: () => void;
    const listed = new Promise<void>((r) => (answer = r));
    mockFetch({ 'GET /campuses': async () => (await listed, { body: { campuses } }), 'GET /events': byCampus });
    const { container } = renderAt('/c/nowhere', routes);
    // Until the campuses are known, no "No events yet" for a link that may be wrong.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/No events/)).not.toBeInTheDocument();
    answer();
    expect(await screen.findByText('This campus link isn’t right.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all events' })).toHaveAttribute('href', '/');
    expect(container.querySelector('.shutter')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'For organisers' })).toBeInTheDocument();
  });

  it('says when a campus has no events', async () => {
    mockFetch({ 'GET /campuses': { body: { campuses } }, 'GET /events': byCampus });
    renderAt('/c/budampadu', routes);
    expect(await screen.findByText('No events at Budampadu yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Earlier events' })).not.toBeInTheDocument();
  });

  it('still shows the events when the server has no campuses yet', async () => {
    mockFetch({ 'GET /events': byCampus });
    renderAt('/c/chebrolu', routes);
    expect(await screen.findByRole('heading', { level: 2, name: 'Fresher Day' })).toBeInTheDocument();
    expect(screen.queryByText('This campus link isn’t right.')).not.toBeInTheDocument();
  });
});

describe('the selfie', () => {
  afterEach(() => {
    delete (navigator as any).mediaDevices;
  });
  const canvas = () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['jpeg'], { type: 'image/jpeg' })));
    Object.assign(URL, { createObjectURL: () => 'blob:selfie', revokeObjectURL: () => {} });
  };

  it('on a computer opens the webcam on the first press, and sends the selfie straight to the search', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    canvas();
    const net = mockFetch({ ...events(studentEvent()), 'POST /e/annual-day/selfie': { body: { ok: true } } });
    const { user, container } = renderAt('/e/annual-day/find', routes);

    const button = await screen.findByRole('button', { name: 'Take selfie' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // The live picture is in the blank print, and the shutter now takes it.
    await waitFor(() => expect(shutter(container)).toHaveTextContent('Capture'));
    expect(container.querySelector('.fd-well video')).toBeInTheDocument();
    expect(net.called('POST /e/annual-day/selfie')).toHaveLength(0);

    await user.click(shutter(container));
    expect(await screen.findByText('Your photos screen')).toBeInTheDocument();
    const sent = net.called('POST /e/annual-day/selfie');
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['x-consent']).toBe('v1');
    expect(sent[0].headers['content-type']).toBe('image/jpeg');
    // The camera is switched off once the selfie is taken.
    expect(stop).toHaveBeenCalled();
  });

  it('on a phone opens the phone’s own camera, never stored pictures', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} }));
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    canvas();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600 })));
    const net = mockFetch({ ...events(studentEvent()), 'POST /e/annual-day/selfie': { body: { ok: true } } });
    const { user, container } = renderAt('/e/annual-day', routes);
    await waitFor(() => expect(shutter(container)).toBeEnabled());
    const camera = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(camera).toHaveAttribute('capture', 'user');
    expect(camera).toHaveAttribute('accept', 'image/*');
    const opened = vi.spyOn(camera, 'click');
    await user.click(shutter(container));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(getUserMedia).not.toHaveBeenCalled();

    await user.upload(camera, new File(['selfie'], 'selfie.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText('Your photos screen')).toBeInTheDocument();
    expect(net.called('POST /e/annual-day/selfie')[0].headers['x-consent']).toBe('v1');
  });

  it('says on a slip when no face was seen', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    canvas();
    mockFetch({ ...events(studentEvent()), 'POST /e/annual-day/selfie': { status: 422, body: { error: 'no_face', message: "We couldn't see your face, try again." } } });
    const { user, container } = renderAt('/e/annual-day', routes);
    await waitFor(() => expect(shutter(container)).toBeEnabled());
    await user.click(shutter(container));
    await waitFor(() => expect(shutter(container)).toHaveTextContent('Capture'));
    await user.click(shutter(container));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't see your face, try again.");
    expect(screen.getByTestId('where')).toHaveTextContent('/e/annual-day');
    expect(shutter(container)).toHaveTextContent('Take selfie');
  });

  it('goes to the album when face search is switched off', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    canvas();
    mockFetch({ ...events(studentEvent()), 'POST /e/annual-day/selfie': { status: 403, body: { error: 'face_off', message: 'Face search is switched off for this event. Use the full album.' } } });
    const { user, container } = renderAt('/e/annual-day', routes);
    await waitFor(() => expect(shutter(container)).toBeEnabled());
    await user.click(shutter(container));
    await waitFor(() => expect(shutter(container)).toHaveTextContent('Capture'));
    await user.click(shutter(container));
    expect(await screen.findByText('The album screen')).toBeInTheDocument();
  });

  it('says on your prints when the selfie had more than one face in it', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    canvas();
    mockFetch({
      ...events(studentEvent()),
      'POST /e/annual-day/selfie': { body: { faces_in_selfie: 3, searched: true, sure: [], maybe: [] } },
      'POST /e/annual-day/session': { body: { event: studentEvent(), me: { album_open: true, searched: true, my_photos: 1, uploads_left: 30 }, contact: null } },
      'GET /e/annual-day/mine': { body: { searched: true, new_photos: 0, more_coming: false, download: true, sure: [media('p1')], maybe: [] } },
    });
    const { user, container } = renderAt(
      '/e/annual-day',
      <>
        <Route path="/e/:slug" element={<Find />} />
        <Route path="/e/:slug/mine" element={<Mine />} />
      </>,
    );
    await waitFor(() => expect(shutter(container)).toBeEnabled());
    await user.click(shutter(container));
    await waitFor(() => expect(shutter(container)).toHaveTextContent('Capture'));
    await user.click(shutter(container));
    expect(await screen.findByText('We found 3 faces in your selfie and searched for the biggest one. For your own photos, take the selfie alone.')).toBeInTheDocument();
  });

  it('says what to do when the camera cannot start', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => Promise.reject(new Error('denied'))) } });
    const net = mockFetch(events(studentEvent()));
    const { user, container } = renderAt('/e/annual-day/find', routes);
    await waitFor(() => expect(shutter(container)).toBeEnabled());
    await user.click(shutter(container));
    expect(await screen.findByRole('alert')).toHaveTextContent(/open this page on your phone and take the selfie there/);
    expect(net.called('POST /e/annual-day/selfie')).toHaveLength(0);
    expect(container.querySelector('.fd-well video')).not.toBeInTheDocument();
  });
});
