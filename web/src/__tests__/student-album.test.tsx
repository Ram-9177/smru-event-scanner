import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { Album, Find, Mine, MyData } from '../student';
import { media, studentEvent, video } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const routes = (
  <>
    <Route path="/e/:slug/album" element={<Album />} />
    <Route path="/e/:slug/mine" element={<Mine />} />
    <Route path="/e/:slug/me" element={<MyData />} />
    <Route path="/e/:slug/find" element={<p>The selfie screen</p>} />
    <Route path="/e/:slug" element={<p>The find screen</p>} />
  </>
);
const photo = (id: string) => media(id);
const mine = { searched: true, new_photos: 0, more_coming: false, download: true, sure: [photo('p2')], maybe: [] };
const me = { album_open: true, searched: true, my_photos: 1, uploads_left: 30 };
const session = (over: Record<string, unknown> = {}) => ({ 'POST /e/annual-day/session': { body: { event: studentEvent(), me: { ...me, ...over }, contact: null } } });

describe('all photos: the contact sheet', () => {
  it('asks for the passcode, then opens the album with your frames circled', async () => {
    let open = false;
    const net = mockFetch({
      'GET /e/annual-day/album': () => (open ? { body: { total: 2, download: true, photos: [photo('p1'), photo('p2')] } } : { status: 403, body: { error: 'passcode_needed', message: 'Enter the album passcode.' } }),
      'POST /e/annual-day/session': (c) => {
        if (c.body.passcode === undefined) return { body: { event: studentEvent({ options: { find: true, album: true, album_locked: true, upload: false, download: true } }), me: { ...me, album_open: open }, contact: null } };
        open = c.body.passcode === '2468';
        return open ? { body: { ok: true } } : { status: 403, body: { error: 'wrong_passcode', message: 'That passcode is not right.' } };
      },
      'GET /e/annual-day/mine': { body: mine },
    });
    const { user } = renderAt('/e/annual-day/album', routes);
    // The session is a POST: it also starts this phone's visit to the event.
    await waitFor(() => expect(net.called('POST /e/annual-day/session')[0].body).toEqual({}));
    await user.type(await screen.findByLabelText(/Album passcode/), '1111');
    await user.click(screen.getByRole('button', { name: 'Open the album' }));
    expect(await screen.findByText('That passcode is not right.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/Album passcode/));
    await user.type(screen.getByLabelText(/Album passcode/), '2468');
    await user.click(screen.getByRole('button', { name: 'Open the album' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'All 2 photos.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open photo 2, one of yours' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open photo 1' })).toBeInTheDocument();
    // The grease-pencil circles are red, and the words say so.
    expect(screen.getByText('circled in red = you')).toBeInTheDocument();
    expect(net.called('GET /e/annual-day/album?offset=0&limit=60').length).toBeGreaterThanOrEqual(2);
  });

  it('loads the next frames on Load more', async () => {
    const first = Array.from({ length: 60 }, (_, i) => photo(`a${i}`));
    const net = mockFetch({
      ...session(),
      'GET /e/annual-day/album': (c) => ({ body: { total: 62, download: true, photos: c.path.includes('offset=60') ? [photo('b1'), photo('b2')] : first } }),
      'GET /e/annual-day/mine': { body: mine },
    });
    const { user } = renderAt('/e/annual-day/album', routes);
    await user.click(await screen.findByRole('button', { name: 'Load the next 2 frames' }));
    expect(await screen.findByRole('button', { name: 'Open photo 62' })).toBeInTheDocument();
    expect(net.called('GET /e/annual-day/album?offset=60&limit=60')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Load the next/ })).not.toBeInTheDocument();
  });
});

describe('my prints', () => {
  it('hangs the photos the selfie found, with Download all', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByRole('button', { name: 'Open photo 1, one of yours' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: '1 print of you.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download all 1/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Hang your shots/ })).toHaveAttribute('href', '/e/annual-day/add');
  });

  it('shows videos among the results, and plays them', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: { ...mine, sure: [photo('p1'), video('v1', 65_000)], maybe: [photo('p3')] } } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    // Your prints, then Might be you, on the same screen.
    expect(await screen.findByText('1 photo and 1 video, all ready')).toBeInTheDocument();
    const tile = screen.getByRole('button', { name: 'Open video 2, one of yours, 1:05 long' });
    expect(within(tile).getByText('1:05')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Might be you (1)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('button', { name: 'Open photo 1' })).toBeInTheDocument();

    await user.click(tile);
    const viewer = screen.getByRole('dialog', { name: 'Video 2' });
    const player = viewer.querySelector('video')!;
    expect(player).toHaveAttribute('src', '/img/v1/v');
    expect(player).toHaveAttribute('poster', '/img/v1/w');
    expect(player).toHaveAttribute('controls');
    expect(within(viewer).getByRole('button', { name: /Not me/ })).toBeInTheDocument();
    // The download is the original, never the small copy.
    expect(within(viewer).getByRole('link', { name: /Download video full quality/ }).getAttribute('href')).toMatch(/^\/api\/e\/annual-day\/original\/v1\?d=[0-9a-f]{48}$/);
  });

  it('starts a video from your results a moment before you are seen in it, and jumps there again on a tap', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: { ...mine, sure: [{ ...video('v1', 65_000), at_ms: 42_000 }] } } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    await user.click(await screen.findByRole('button', { name: /Open video 1/ }));
    const viewer = screen.getByRole('dialog', { name: 'Video 1' });
    const player = viewer.querySelector('video')!;
    player.dispatchEvent(new Event('loadedmetadata'));
    expect(player.currentTime).toBe(41); // a second before
    player.currentTime = 3;
    await user.click(within(viewer).getByRole('button', { name: 'You at 0:42' }));
    expect(player.currentTime).toBe(41);
  });

  it('filters the results by Solo, Duo and Group, and hides the empty ones', async () => {
    mockFetch({
      ...session(),
      'GET /e/annual-day/mine': {
        body: { ...mine, sure: [media('a', { kind: 'solo' }), media('b', { kind: 'group' }), media('c', { kind: 'group' })], maybe: [media('d', { kind: 'group' })] },
      },
    });
    const { user } = renderAt('/e/annual-day/mine', routes);
    const tabs = await screen.findByRole('group', { name: 'Who is in them' });
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent)).toEqual(['All (4)', 'Solo (1)', 'Group (3)']);
    expect(screen.getAllByRole('button', { name: /one of yours/ })).toHaveLength(3);

    await user.click(within(tabs).getByRole('button', { name: 'Group (3)' }));
    expect(screen.getAllByRole('button', { name: /one of yours/ })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Might be you (1)' })).toBeInTheDocument();

    await user.click(within(tabs).getByRole('button', { name: 'Solo (1)' }));
    expect(screen.getAllByRole('button', { name: /one of yours/ })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: /Might be you/ })).not.toBeInTheDocument();
  });

  it('ticks prints and downloads the ticked ones in full quality', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: { ...mine, sure: [photo('p1'), photo('p2')] } }, 'GET /e/annual-day/original/p2': { body: {} } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByRole('button', { name: /Download all 2/ })).toBeInTheDocument();
    const tick = screen.getByRole('button', { name: 'Select photo 2' });
    await user.click(tick);
    expect(tick).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Download 1 selected/ }));
    expect(await screen.findByRole('button', { name: /1 photo saved/ })).toBeInTheDocument();
    expect(net.calls.filter((c) => c.path.startsWith('/e/annual-day/original/p2?d='))).toHaveLength(1);
    expect(net.called('POST /e/annual-day/zip')).toHaveLength(0);
  });

  it('on a phone sends the ticked originals to its share sheet together, and stays on the page', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} }));
    const share = vi.fn(async (_: ShareData) => {});
    Object.assign(navigator, { canShare: () => true, share });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: { ...mine, sure: [photo('p1'), photo('p2')] } }, 'GET /e/annual-day/original/p1': { body: {} }, 'GET /e/annual-day/original/p2': { body: {} } });
      const { user } = renderAt('/e/annual-day/mine', routes);
      await user.click(await screen.findByRole('button', { name: 'Select photo 1' }));
      await user.click(screen.getByRole('button', { name: 'Select photo 2' }));
      await user.click(screen.getByRole('button', { name: /Download 2 selected/ }));
      expect(await screen.findByRole('button', { name: /2 photos saved/ })).toBeInTheDocument();
      expect(share).toHaveBeenCalledTimes(1);
      expect(share.mock.calls[0][0].files!.map((f) => f.name)).toEqual(['annual-day-01.jpg', 'annual-day-02.jpg']);
      expect(click).not.toHaveBeenCalled();
      expect(net.calls.filter((c) => c.path.startsWith('/e/annual-day/original/'))).toHaveLength(2);
    } finally {
      delete (navigator as any).canShare;
      delete (navigator as any).share;
    }
  });

  it('Download all asks the server for the ZIP of your photos', async () => {
    const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine }, 'POST /e/annual-day/zip': { body: { count: 1, url: '#zip' } } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    await user.click(await screen.findByRole('button', { name: /Download all 1/ }));
    await waitFor(() => expect(net.called('POST /e/annual-day/zip')).toHaveLength(1));
  });

  it('takes a photo out of your prints on Not me', async () => {
    const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: { ...mine, sure: [photo('p1'), photo('p2')] } }, 'POST /e/annual-day/mine/p1/not-me': { body: { ok: true } } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    await user.click(await screen.findByRole('button', { name: 'Open photo 1, one of yours' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Not me' }));
    expect(await screen.findByText('Removed from your prints.')).toBeInTheDocument();
    expect(net.called('POST /e/annual-day/mine/p1/not-me')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /one of yours/ })).toHaveLength(1);
  });

  it('asks why a photo is reported, and sends the reason picked', async () => {
    const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: { ...mine, sure: [photo('p1'), photo('p2')] } }, 'POST /e/annual-day/report': { status: 201, body: { ok: true } } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    await user.click(await screen.findByRole('button', { name: 'Open photo 1, one of yours' }));
    const viewer = screen.getByRole('dialog');
    await user.click(within(viewer).getByRole('button', { name: 'Report this photo' }));
    expect(net.called('POST /e/annual-day/report')).toHaveLength(0);
    const why = within(viewer).getByRole('group', { name: /Why are you reporting this photo/ });
    expect(within(why).getByRole('button', { name: 'I’m in it and want it removed' })).toHaveFocus();
    await user.click(within(why).getByRole('button', { name: 'I’m in it and want it removed' }));
    expect(await within(viewer).findByRole('button', { name: 'Reported to the organiser. Thank you.' })).toBeDisabled();
    expect(net.called('POST /e/annual-day/report')[0].body).toEqual({ media_id: 'p1', reason: 'I’m in it and want it removed' });

    // Something else: a few words of your own, up to 300 characters.
    await user.click(within(viewer).getByRole('button', { name: 'Next' }));
    await user.click(within(viewer).getByRole('button', { name: 'Report this photo' }));
    await user.click(within(viewer).getByRole('button', { name: 'Something else' }));
    const box = within(viewer).getByLabelText(/A few words/);
    expect(box).toHaveAttribute('maxlength', '300');
    await user.type(box, 'My little brother is in it');
    await user.click(within(viewer).getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(net.called('POST /e/annual-day/report')).toHaveLength(2));
    expect(net.called('POST /e/annual-day/report')[1].body).toEqual({ media_id: 'p2', reason: 'My little brother is in it' });
  });

  it('Share in the viewer: saves the photo where files cannot be shared, and says when sharing fails', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let canShare = false;
    const share = vi.fn(async (_: ShareData) => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })));
    Object.assign(navigator, { canShare: () => canShare, share });
    try {
      const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine }, 'GET /img/p2/w': { body: {} } });
      const { user } = renderAt('/e/annual-day/mine', routes);
      await user.click(await screen.findByRole('button', { name: 'Open photo 1, one of yours' }));
      const viewer = screen.getByRole('dialog');
      await user.click(within(viewer).getByRole('button', { name: 'Share' }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(share).not.toHaveBeenCalled();
      // fetched through the app (pipe=1), never by following the redirect to OneDrive (that needs CORS from Microsoft)
      expect(net.calls.filter((c) => c.path === '/img/p2/w?pipe=1')).toHaveLength(1);

      canShare = true;
      await user.click(within(viewer).getByRole('button', { name: 'Share' }));
      expect(await within(viewer).findByText('This photo could not be shared.')).toBeInTheDocument();
      expect(share).toHaveBeenCalledTimes(1);
    } finally {
      delete (navigator as any).canShare;
      delete (navigator as any).share;
    }
  });

  it('sends a phone that has not searched to the selfie', async () => {
    mockFetch({ ...session({ searched: false }), 'GET /e/annual-day/mine': { body: { ...mine, searched: false, sure: [] } } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByText('The selfie screen')).toBeInTheDocument();
  });
});

describe('delete my results', () => {
  it('asks first, then deletes this phone’s results for the event', async () => {
    const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine }, 'DELETE /e/annual-day/me': { body: { ok: true } } });
    const { user } = renderAt('/e/annual-day/me', routes);
    const dialog = await screen.findByRole('dialog', { name: 'Delete my results?' });
    expect(within(dialog).getByText(/The photos themselves stay in the album/)).toBeInTheDocument();
    expect(net.called('DELETE /e/annual-day/me')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: /Delete/ }));
    expect(await screen.findByText('The find screen')).toBeInTheDocument();
    expect(net.called('DELETE /e/annual-day/me')).toHaveLength(1);
  });

  it('says on Find that the results were deleted, once', async () => {
    mockFetch({
      ...session(),
      'GET /e/annual-day/mine': { body: mine },
      'DELETE /e/annual-day/me': { body: { ok: true } },
      'GET /events': { body: { org: "St. Mary's", contact: null, events: [studentEvent()] } },
      'GET /campuses': { body: { campuses: [] } },
    });
    const { user } = renderAt(
      '/e/annual-day/me',
      <>
        <Route path="/e/:slug/me" element={<MyData />} />
        <Route path="/e/:slug" element={<Find />} />
      </>,
    );
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete my results?' })).getByRole('button', { name: /Delete/ }));
    expect(await screen.findByText('Your results were deleted.')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/e\/annual-day$/);
    expect(await screen.findByRole('heading', { name: 'Annual Day 2026' })).toBeInTheDocument();
  });
});

describe('opened from a campus home', () => {
  it('keeps the campus on the way back and between the tabs', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine } });
    renderAt('/e/annual-day/mine?campus=chebrolu', routes);
    expect(await screen.findByRole('link', { name: 'Back to events' })).toHaveAttribute('href', '/e/annual-day?campus=chebrolu');
    expect(await screen.findByRole('link', { name: /^My prints/ })).toHaveAttribute('href', '/e/annual-day/mine?campus=chebrolu');
    expect(screen.getByRole('link', { name: /^All photos/ })).toHaveAttribute('href', '/e/annual-day/album?campus=chebrolu');
  });
});

describe('photos that live in OneDrive', () => {
  it('a tile whose copy is being prepared shows a quiet frame and asks again after 5 s, 20 s and 60 s', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine } });
    renderAt('/e/annual-day/mine', routes);
    const tile = await screen.findByRole('button', { name: 'Open photo 1, one of yours' });
    const img = tile.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/img/p2/t');
    vi.useFakeTimers();
    try {
      fireEvent.error(img);
      expect(img).toHaveClass('is-preparing');
      act(() => void vi.advanceTimersByTime(4900));
      expect(img.getAttribute('src')).toBe('/img/p2/t');
      act(() => void vi.advanceTimersByTime(200));
      expect(img.getAttribute('src')).toBe('/img/p2/t?r=1');
      fireEvent.error(img);
      act(() => void vi.advanceTimersByTime(20_000));
      expect(img.getAttribute('src')).toBe('/img/p2/t?r=2');
      fireEvent.load(img); // there now
      expect(img).not.toHaveClass('is-preparing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when OneDrive is not giving the photos ("images_ok": false)', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: { ...mine, images_ok: false } } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByText("Photos can't be loaded right now. OneDrive isn't answering; try again in a few minutes.")).toHaveAttribute('role', 'status');
  });

  it('shows no such line while OneDrive answers', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: { ...mine, images_ok: true } } });
    renderAt('/e/annual-day/mine', routes);
    await screen.findByRole('button', { name: 'Open photo 1, one of yours' });
    expect(screen.queryByText(/Photos can't be loaded right now/)).not.toBeInTheDocument();
  });

  it('a video whose OneDrive link ran out during a long viewing loads a fresh one and goes on at the same moment', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: { ...mine, sure: [video('v1', 65_000)] } } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    await user.click(await screen.findByRole('button', { name: /Open video 1/ }));
    const player = screen.getByRole('dialog', { name: 'Video 1' }).querySelector('video')!;
    const play = vi.fn(async () => {});
    Object.assign(player, { play, load: () => {} });
    player.currentTime = 30;
    fireEvent.error(player);
    expect(player.getAttribute('src')).toMatch(/^\/img\/v1\/v\?r=\d+$/);
    player.currentTime = 0;
    fireEvent(player, new Event('loadedmetadata'));
    expect(player.currentTime).toBe(30);
    expect(play).toHaveBeenCalledTimes(1);
    // once a minute at most: a second error straight away does not reload again
    const src = player.getAttribute('src');
    fireEvent.error(player);
    expect(player.getAttribute('src')).toBe(src);
  });
});
