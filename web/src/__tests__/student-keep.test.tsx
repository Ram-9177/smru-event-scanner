import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushBlock, subscribePush } from '../lib/push';
import { Find, Mine, MyData } from '../student';
import { media, studentEvent } from './fixtures';
import { mockFetch, renderAt } from './helpers';

/* Keep me updated (feature E) and face search ended (feature G), on the student side. */

const routes = (
  <>
    <Route path="/" element={<Find />} />
    <Route path="/e/:slug" element={<Find />} />
    <Route path="/e/:slug/find" element={<Find />} />
    <Route path="/e/:slug/mine" element={<Mine />} />
    <Route path="/e/:slug/me" element={<MyData />} />
    <Route path="/e/:slug/album" element={<p>The album screen</p>} />
  </>
);
const me = { album_open: true, searched: true, my_photos: 1, uploads_left: 30 };
const keep = (over: Record<string, unknown> = {}) => ({ available: true, on: false, push: false, consent_version: 'k1', ...over });
const mine = (over: Record<string, unknown> = {}) => ({ searched: true, new_photos: 0, more_coming: false, download: true, sure: [media('p1')], maybe: [], keep: keep(), removal: null, fresh_count: 0, ...over });
const session = (slug = 'annual-day', ev: Record<string, unknown> = {}) => ({ [`POST /e/${slug}/session`]: { body: { event: studentEvent({ slug, ...ev }), me, contact: null } } });
const events = (...list: ReturnType<typeof studentEvent>[]) => ({ 'GET /events': { body: { org: "St. Mary's", contact: null, events: list } } });
const shutter = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.fd-dock .shutter')!;
const BOX = 'Tell me when new photos of me arrive';

function stubCamera() {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as any);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['jpeg'], { type: 'image/jpeg' })));
  Object.assign(URL, { createObjectURL: () => 'blob:selfie', revokeObjectURL: () => {} });
}

/** A phone that can get notifications: a service worker, PushManager and Notification. */
function stubPush(opts: { permission?: NotificationPermission; answer?: NotificationPermission; ua?: string } = {}) {
  const sub = { endpoint: 'https://push.example/abc', options: { applicationServerKey: null }, toJSON: () => ({ endpoint: 'https://push.example/abc', expirationTime: null, keys: { p256dh: 'P256', auth: 'AUTH' } }), unsubscribe: vi.fn(async () => true) };
  const subscribe = vi.fn(async () => sub);
  const reg = { pushManager: { getSubscription: vi.fn(async () => null), subscribe } };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(reg), getRegistration: async () => reg } });
  const requestPermission = vi.fn(async () => opts.answer ?? 'granted');
  vi.stubGlobal('Notification', { permission: opts.permission ?? 'default', requestPermission });
  vi.stubGlobal('PushManager', function PushManager() {});
  if (opts.ua) vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(opts.ua);
  return { subscribe, requestPermission };
}

afterEach(() => {
  delete (navigator as any).mediaDevices;
  delete (navigator as any).serviceWorker;
});

describe('keep me updated', () => {
  it('turns on with the selfie still in memory, sends its own consent, and turns off in one tap', async () => {
    stubCamera();
    const net = mockFetch({
      ...events(studentEvent()),
      ...session(),
      'POST /e/annual-day/selfie': { body: { faces_in_selfie: 1 } },
      'GET /e/annual-day/mine': { body: mine() },
      'POST /e/annual-day/keep': { body: { keep: keep({ on: true }) } },
      'DELETE /e/annual-day/keep': { body: { keep: keep() } },
      'DELETE /e/annual-day/push': { body: { ok: true } },
    });
    const { user, container } = renderAt('/e/annual-day', routes);
    await waitFor(() => expect(shutter(container)).toBeEnabled());
    await user.click(shutter(container));
    await waitFor(() => expect(shutter(container)).toHaveTextContent('Capture'));
    await user.click(shutter(container));

    const box = await screen.findByRole('checkbox', { name: BOX });
    expect(box).not.toBeChecked();
    // Its own consent line, next to the box.
    expect(box).toHaveAccessibleDescription(/we keep a code made from your face \(never the selfie itself\), for this event only/);
    // Nothing is kept by the search itself.
    expect(net.called('POST /e/annual-day/keep')).toHaveLength(0);

    await user.click(box);
    expect(await screen.findByText("On. We'll tell you when new photos of you arrive.")).toBeInTheDocument();
    expect(box).toBeChecked();
    const sent = net.called('POST /e/annual-day/keep');
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['x-keep-consent']).toBe('k1');
    expect(sent[0].headers['content-type']).toBe('image/jpeg');
    expect(sent[0].body).toBeInstanceOf(Blob);
    // jsdom has no push: the student is told where the new photos will show.
    expect(screen.getByText("You'll see new photos here when you come back.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Allow notifications/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stop telling me' }));
    expect(await screen.findByText('Turned off. Your face code is deleted.')).toBeInTheDocument();
    expect(net.called('DELETE /e/annual-day/keep')).toHaveLength(1);
    await waitFor(() => expect(net.called('DELETE /e/annual-day/push')).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: BOX })).not.toBeChecked();
    // The Stop button has gone: the keyboard is back on the box, not lost.
    expect(screen.getByRole('checkbox', { name: BOX })).toHaveFocus();
  });

  it('asks for a new selfie when none is in this tab', async () => {
    const net = mockFetch({ ...session('fresher-day'), 'GET /e/fresher-day/mine': { body: mine() } });
    const { user } = renderAt('/e/fresher-day/mine', routes);
    await user.click(await screen.findByRole('checkbox', { name: BOX }));
    expect(screen.getByRole('checkbox', { name: BOX })).not.toBeChecked();
    const say = screen.getByText((_, el) => el?.textContent === 'Take a new selfie to turn this on.' && el.tagName === 'P');
    expect(within(say).getByRole('link', { name: 'Take a new selfie' })).toHaveAttribute('href', '/e/fresher-day/find');
    expect(net.called('POST /e/fresher-day/keep')).toHaveLength(0);
  });

  it('keeps the campus on the way to a new selfie', async () => {
    mockFetch({ ...session('fresher-day'), 'GET /e/fresher-day/mine': { body: mine() } });
    const { user } = renderAt('/e/fresher-day/mine?campus=chebrolu', routes);
    await user.click(await screen.findByRole('checkbox', { name: BOX }));
    expect(screen.getByRole('link', { name: 'Take a new selfie' })).toHaveAttribute('href', '/e/fresher-day/find?campus=chebrolu');
  });

  it('does not offer it when the server says it is not available', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine({ keep: keep({ available: false }) }) } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByRole('button', { name: /Open photo 1/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: BOX })).not.toBeInTheDocument();
  });

  it('asks for notifications only after a tap on Allow notifications, and sends the subscription', async () => {
    const { subscribe, requestPermission } = stubPush();
    const net = mockFetch({
      ...session(),
      'GET /e/annual-day/mine': { body: mine({ keep: keep({ on: true }) }) },
      'GET /push/key': { body: { key: 'BAEC_-w' } },
      'POST /e/annual-day/push': { status: 201, body: { ok: true } },
    });
    const { user } = renderAt('/e/annual-day/mine', routes);
    const allow = await screen.findByRole('button', { name: /Allow notifications/ });
    expect(requestPermission).not.toHaveBeenCalled();

    await user.click(allow);
    await waitFor(() => expect(net.called('POST /e/annual-day/push')).toHaveLength(1));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const opts = (subscribe.mock.calls[0] as any[])[0];
    expect(opts.userVisibleOnly).toBe(true);
    expect(Array.from(opts.applicationServerKey as Uint8Array)).toEqual([4, 1, 2, 255, 236]);
    expect(net.called('POST /e/annual-day/push')[0].body).toEqual({ endpoint: 'https://push.example/abc', keys: { p256dh: 'P256', auth: 'AUTH' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Allow notifications/ })).not.toBeInTheDocument());
  });

  it('says what happens when notifications are refused', async () => {
    stubPush({ answer: 'denied' });
    const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine({ keep: keep({ on: true }) }) }, 'GET /push/key': { body: { key: 'BAEC_-w' } } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    // The stub's permission turns "denied" once refused.
    vi.mocked(Notification.requestPermission).mockImplementation(async () => {
      (Notification as any).permission = 'denied';
      return 'denied';
    });
    await user.click(await screen.findByRole('button', { name: /Allow notifications/ }));
    expect(await screen.findByText("Notifications are off for this site. You'll see new photos here when you come back.")).toBeInTheDocument();
    expect(net.called('POST /e/annual-day/push')).toHaveLength(0);
  });

  it('tells an iPhone to add the page to the Home Screen first', async () => {
    stubPush({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    expect(pushBlock()).toBe('ios_not_installed');
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine({ keep: keep({ on: true }) }) } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByText("On iPhone, add this page to your Home Screen to get a notification. Otherwise you'll see new photos here when you come back.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Allow notifications/ })).not.toBeInTheDocument();
  });

  it('asks for permission straight away in the tap, before waiting for the network', async () => {
    const { requestPermission } = stubPush();
    mockFetch({ 'GET /push/key': { body: { key: 'BAEC_-w' } }, 'POST /e/annual-day/push': { status: 201, body: { ok: true } } });
    const done = subscribePush('annual-day');
    // Safari on an iPhone only asks while the tap is still running.
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(await done).toBe(true);
  });

  it('subscribes to nothing when the server has no key', async () => {
    const { subscribe } = stubPush();
    const net = mockFetch({ 'GET /push/key': { body: { key: null } } });
    expect(await subscribePush('annual-day')).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
    expect(net.called('POST /e/annual-day/push')).toHaveLength(0);
  });

  it('knows when a phone cannot get notifications at all', () => {
    expect(pushBlock()).toBe('unsupported');
    stubPush({ permission: 'denied' });
    expect(pushBlock()).toBe('denied');
  });

  it('marks the new photos, says how many, then tells the server they were seen', async () => {
    const net = mockFetch({
      ...session(),
      'GET /e/annual-day/mine': { body: mine({ sure: [media('p1'), media('p2', { fresh: true }), media('p3', { fresh: true })], fresh_count: 2, keep: keep({ on: true, push: true }) }) },
      'POST /e/annual-day/mine/seen': { body: { ok: true } },
    });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByText('2 new photos of you arrived since your last visit.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open photo 2, one of yours, new' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open photo 1, one of yours' })).toBeInTheDocument();
    expect(screen.getAllByText('New')).toHaveLength(2);
    await waitFor(() => expect(net.called('POST /e/annual-day/mine/seen')).toHaveLength(1), { timeout: 3000 });
  });

  it('says it is checking new photos instead of asking for a new selfie', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine({ new_photos: 4, keep: keep({ on: true, push: true }) }) } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByText("We're checking new photos for you.")).toBeInTheDocument();
    expect(screen.queryByText(/added since your selfie/)).not.toBeInTheDocument();
  });

  it('shows "N new" on the event frame of Find', async () => {
    mockFetch(events(studentEvent({ mine: 5, mine_new: 3 })));
    renderAt('/e/annual-day', routes);
    const frame = await screen.findByRole('img', { name: /^Annual Day 2026.*5 of you, 3 new$/ });
    expect(within(frame).getByText('3 new')).toBeInTheDocument();
  });

  it('explains Keep me updated in the fine print', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine() } });
    renderAt('/e/annual-day/me', routes);
    expect(
      await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === "Keep me updated: only if you tick it, we keep a code made from your face for this event, until you turn it off, delete your results, or the event's face search ends."),
    ).toBeInTheDocument();
  });
});

describe('face search ended', () => {
  const ended = { face_ended: true, options: { find: false, album: true, album_locked: false, upload: false, download: true } };

  it('turns the selfie off on Find and points to the whole album', async () => {
    mockFetch(events(studentEvent(ended)));
    const { container } = renderAt('/e/annual-day', routes);
    const links = await screen.findAllByRole('link', { name: 'Face search ended — browse all photos' });
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l).toHaveAttribute('href', '/e/annual-day/album');
    expect(shutter(container)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Take a selfie' })).not.toBeInTheDocument();
  });

  it('keeps the results found before on My prints, without Keep me updated or Retake', async () => {
    mockFetch({ ...session('annual-day', ended), 'GET /e/annual-day/mine': { body: mine({ keep: keep({ available: false }) }) } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByRole('button', { name: 'Open photo 1, one of yours' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/e/annual-day/mine');
    expect(screen.queryByRole('checkbox', { name: BOX })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Retake selfie' })).not.toBeInTheDocument();
  });

  it('does not ask for another selfie when nothing was found before it ended', async () => {
    mockFetch({ ...session('annual-day', ended), 'GET /e/annual-day/mine': { body: mine({ sure: [], keep: keep({ available: false }) }) } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByRole('heading', { level: 1, name: 'No prints of you yet.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Face search ended — browse all photos' })).toHaveAttribute('href', '/e/annual-day/album');
    expect(screen.queryByText(/Try another selfie/)).not.toBeInTheDocument();
  });
});
