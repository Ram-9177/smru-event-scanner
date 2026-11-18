import { describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { mockFetch } from './helpers';

describe('api()', () => {
  it('reads JSON from /api and sends the device token', async () => {
    const { calls } = mockFetch({ 'GET /events': { body: { events: [] } } });
    await expect(api('/events')).resolves.toEqual({ events: [] });
    expect(calls[0].path).toBe('/events');
    expect(calls[0].headers['x-device']).toMatch(/^[0-9a-f]{48}$/);
  });

  it('keeps the same device token between calls', async () => {
    const { calls } = mockFetch({ 'GET /events': { body: {} } });
    await api('/events');
    await api('/events');
    expect(calls[0].headers['x-device']).toBe(calls[1].headers['x-device']);
  });

  it('posts JSON when given json', async () => {
    const { calls } = mockFetch({ 'POST /admin/login': { body: { ok: true } } });
    await api('/admin/login', { json: { email: 'a@b.c', password: 'x' } });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { email: 'a@b.c', password: 'x' } });
    expect(calls[0].headers['content-type']).toBe('application/json');
  });

  it('turns an error answer into an ApiError with status, code and message', async () => {
    mockFetch({ 'GET /admin/me': { status: 401, body: { error: 'not_signed_in', message: 'Sign in first.' } } });
    const err = await api('/admin/me').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'not_signed_in', message: 'Sign in first.' });
  });

  it('gives a plain message when the error answer is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })));
    const err = await api('/events').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: 'error', message: 'Something went wrong. Try again.' });
  });

  it('reports no connection as offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = await api('/events').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'offline', message: 'No connection. Check your internet and try again.' });
  });
});
