// Web Push for Keep me updated (bigger-contract.md, feature E). Owner: web-student.
// The phone asks for permission only when the student turns Keep me updated on and taps Allow notifications,
// never on arrival.
import { api } from './api';

/** Why a phone cannot get notifications: it can (null), the browser has no push, an iPhone not added to the Home Screen, or refused. */
export type PushBlock = null | 'unsupported' | 'ios_not_installed' | 'denied';

/** An iPhone or iPad (iPadOS says it is a Mac, but a Mac has no touch screen). */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

/** Opened from the Home Screen rather than in the browser. */
function standalone(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** Whether this phone can get a notification about new photos, and if not, why. */
export function pushBlock(): PushBlock {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  // Safari on an iPhone has push only for pages added to the Home Screen.
  if (isIos() && !standalone()) return 'ios_not_installed';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return null;
}

/** The server's public key arrives as base64url; the browser wants the bytes. */
function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** The service worker, or null when there is none (it is registered only in the built app) within a few seconds. */
async function worker(wait = 8000): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  let timer = 0;
  const late = new Promise<null>((ok) => (timer = window.setTimeout(() => ok(null), wait)));
  try {
    return await Promise.race([navigator.serviceWorker.ready, late]);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Ask for permission (while fetching the server's key, GET /api/push/key), subscribe through the service worker with
 * that key and send the subscription to POST /api/e/:slug/push. Resolves true when the phone is now subscribed.
 * Call it straight from a tap, before any await.
 */
export async function subscribePush(slug: string): Promise<boolean> {
  if (pushBlock() !== null) return false;
  try {
    // Both start before anything is awaited: Safari on an iPhone asks for permission only while the tap that
    // called this is still running, and a network wait first would lose it.
    const keyP = api<{ key: string | null }>('/push/key').then(
      (r) => r.key,
      () => null,
    );
    const permission = await Notification.requestPermission();
    const key = await keyP;
    if (permission !== 'granted' || !key) return false;
    const reg = await worker();
    if (!reg?.pushManager) return false;
    const applicationServerKey = keyBytes(key);
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with an older key cannot be reused: the browser refuses a second key.
    if (sub && !sameKey(sub.options?.applicationServerKey, applicationServerKey)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
    await api(`/e/${encodeURIComponent(slug)}/push`, { json: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tell the server to forget this phone's subscription for the event (DELETE /api/e/:slug/push). The browser's own
 * subscription stays: it is shared by every event this phone follows.
 */
export async function unsubscribePush(slug: string): Promise<void> {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const sub = await reg?.pushManager?.getSubscription();
    await api(`/e/${encodeURIComponent(slug)}/push`, { method: 'DELETE', json: sub?.endpoint ? { endpoint: sub.endpoint } : {} });
  } catch {
    /* the server forgets it anyway when Keep me updated is turned off */
  }
}
