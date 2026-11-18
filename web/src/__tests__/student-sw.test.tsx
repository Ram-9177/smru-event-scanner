import { describe, expect, it, vi } from 'vitest';
import code from '../../public/sw.js?raw';

/* The service worker's notifications for Keep me updated (web/public/sw.js), run against a stand-in worker scope. */

const ORIGIN = 'https://photos.college.edu';

function worker(windows: { url: string; navigate?: boolean }[] = []) {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = vi.fn(async () => {});
  const navigated: string[] = [];
  const clients = windows.map((w) => {
    const c: any = { url: w.url, focus: vi.fn(async () => c) };
    if (w.navigate !== false) c.navigate = vi.fn(async (u: string) => (navigated.push(u), c));
    return c;
  });
  const openWindow = vi.fn(async () => null);
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { showNotification },
    clients: { matchAll: vi.fn(async () => clients), openWindow, claim: async () => {} },
    addEventListener: (name: string, fn: (event: any) => void) => (handlers[name] = fn),
    skipWaiting: () => {},
  };
  new Function('self', 'caches', 'fetch', code)(self, {}, () => Promise.reject(new Error('no network')));
  /** Fires an event and waits for what it handed to waitUntil. */
  const fire = async (name: string, event: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers[name]({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { fire, showNotification, openWindow, clients, navigated, code };
}

describe('the service worker', () => {
  it('is a new version, so phones pick up the notification code', () => {
    expect(code).toContain("const SHELL = 'ep-shell-v5'");
  });

  it('shows "N new photos of you at <event>" from the push', async () => {
    const w = worker();
    const payload = { title: 'Event Photos', body: "3 new photos of you at Freshers' Day", url: '/e/freshers/mine', tag: 'ep-new-freshers', count: 3, event: "Freshers' Day" };
    await w.fire('push', { data: { json: () => payload } });
    expect(w.showNotification).toHaveBeenCalledWith('Event Photos', {
      body: "3 new photos of you at Freshers' Day",
      tag: 'ep-new-freshers',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: '/e/freshers/mine' },
    });
  });

  it('still says something when the push has no data or bad data', async () => {
    const w = worker();
    await w.fire('push', { data: null });
    await w.fire('push', {
      data: {
        json: () => {
          throw new SyntaxError('bad');
        },
      },
    });
    expect(w.showNotification).toHaveBeenCalledTimes(2);
    for (const call of w.showNotification.mock.calls as unknown[][]) expect(call).toEqual(['Event Photos', { body: 'New photos of you have arrived.', data: { url: '/' } }]);
  });

  it('never opens another site from a notification', async () => {
    const w = worker();
    for (const url of ['//evil.example/x', '/\\evil.example/x', '/\\/evil.example', 'https://evil.example/x', 'javascript:alert(1)']) {
      await w.fire('push', { data: { json: () => ({ title: 'Event Photos', body: 'x', url, tag: 't' }) } });
    }
    for (const call of w.showNotification.mock.calls as any[][]) expect(call[1].data).toEqual({ url: '/' });
    // Even a click on a notification that somehow carries another site opens this one.
    await w.fire('notificationclick', { notification: { close() {}, data: { url: '/\\evil.example/x' } } });
    expect(w.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it('on a tap focuses an open window of the app and takes it to My prints', async () => {
    const w = worker([{ url: 'https://other.example/' }, { url: `${ORIGIN}/` }]);
    const close = vi.fn();
    await w.fire('notificationclick', { notification: { close, data: { url: '/e/freshers/mine' } } });
    expect(close).toHaveBeenCalled();
    expect(w.clients[1].focus).toHaveBeenCalled();
    expect(w.navigated).toEqual([`${ORIGIN}/e/freshers/mine`]);
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window when the app is not open', async () => {
    const w = worker();
    await w.fire('notificationclick', { notification: { close() {}, data: { url: '/e/freshers/mine' } } });
    expect(w.openWindow).toHaveBeenCalledWith(`${ORIGIN}/e/freshers/mine`);
  });
});

/* Thumbnails live in OneDrive: the app redirects to a short-lived OneDrive link, which the worker sees as an opaque answer. */
function cachingWorker(answer: (url: string) => { ok: boolean; type: string; status?: number }) {
  const handlers: Record<string, (event: any) => void> = {};
  const stores = new Map<string, Map<string, any>>([['ep-thumbs-v1', new Map([['old', {}]])], ['ep-other', new Map()]]);
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (req: any) => m.get(typeof req === 'string' ? req : req.url),
      put: async (req: any, res: any) => void m.set(typeof req === 'string' ? req : req.url, res),
      keys: async () => [...m.keys()].map((url) => ({ url })),
      delete: async (req: any) => m.delete(typeof req === 'string' ? req : req.url),
      addAll: async () => {},
    };
  };
  const caches = { open: async (name: string) => store(name), keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name), match: async () => undefined };
  const fetched: string[] = [];
  const fetchFn = async (req: any) => {
    fetched.push(req.url);
    const a = answer(req.url);
    const res = { ...a, clone: () => res };
    return res;
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { showNotification: async () => {} },
    clients: { matchAll: async () => [], openWindow: async () => null, claim: async () => {} },
    addEventListener: (name: string, fn: (event: any) => void) => (handlers[name] = fn),
    skipWaiting: () => {},
  };
  new Function('self', 'caches', 'fetch', code)(self, caches, fetchFn);
  const get = async (url: string) => {
    const box: { answered: Promise<any> | null } = { answered: null };
    handlers.fetch({ request: { url: `${ORIGIN}${url}`, method: 'GET', mode: 'no-cors' }, respondWith: (p: Promise<any>) => (box.answered = p) });
    return box.answered ? await box.answered : null;
  };
  const activate = async () => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers.activate({ waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { get, activate, stores, fetched };
}

describe('the service worker and thumbnails in OneDrive', () => {
  it('passes a redirected (opaque) thumbnail through without caching it', async () => {
    const w = cachingWorker(() => ({ ok: false, type: 'opaqueredirect', status: 0 }));
    const res = await w.get('/img/abc/t?e=1&s=x');
    expect(res!.type).toBe('opaqueredirect');
    expect(w.stores.get('ep-thumbs-v2')?.size ?? 0).toBe(0);
    await w.get('/img/abc/t?e=1&s=x');
    expect(w.fetched).toHaveLength(2); // asked again: nothing was kept
  });

  it('still keeps a thumbnail the app sent itself (a plain 200 from this site)', async () => {
    const w = cachingWorker(() => ({ ok: true, type: 'basic', status: 200 }));
    await w.get('/img/abc/t?e=1&s=x');
    await w.get('/img/abc/t?e=1&s=x');
    expect(w.fetched).toHaveLength(1);
    expect(w.stores.get('ep-thumbs-v2')?.size).toBe(1);
  });

  it('drops the old thumbnail cache (v1) when it takes over', async () => {
    const w = cachingWorker(() => ({ ok: true, type: 'basic' }));
    await w.activate();
    expect(w.stores.has('ep-thumbs-v1')).toBe(false);
    expect(code).toContain("const THUMBS = 'ep-thumbs-v2'");
  });
});
